/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Angular ライフサイクル (Signals) パターン版 ダッシュボードページ
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 【新スタイルの特徴】
 *  - afterNextRender  : AfterViewInit の代替。DOM 確定後に一度だけ実行される
 *  - afterRenderEffect: DOM 書き込みフェーズで Signal を自動追跡して再実行
 *  - DestroyRef       : OnDestroy インターフェース不要でクリーンアップを登録
 *  - inject()         : constructor 引数の代わりにフィールドで DI
 *  - firstValueFrom() : toPromise() の後継。Observable を一度だけ待つ
 *
 * 【利点】
 *  - Subject / takeUntil の定型コードが不要
 *  - Signal への書き込みと DOM 反映の責務が明確に分離される
 *    ResizeObserver → Signal に書く  /  afterRenderEffect → DOM に反映
 *  - constructor ベースで副作用をすべて宣言できる
 *
 * 【課題】
 *  - debounceTime のような細かい制御は自前実装が必要
 *  - afterRenderEffect は SSR (サーバーサイドレンダリング) では実行されない
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  Component,
  DestroyRef,
  ElementRef,
  ViewChild,
  afterNextRender,
  afterRenderEffect,
  inject,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { embedDashboard } from '@superset-ui/embedded-sdk';
import { SupersetService } from '../../services/superset.service';

@Component({
  selector: 'app-lifecycle-dashboard',
  standalone: true,
  templateUrl: './lifecycle-dashboard.component.html',
  styleUrl: './lifecycle-dashboard.component.scss',
  host: { style: 'display: block; width: 100%; height: 100%;' },
})
export class LifecycleDashboardComponent {
  // ── DOM 参照 ──────────────────────────────────────────────────────────────
  @ViewChild('dashboardContainer', { static: true })
  private readonly dashboardContainer!: ElementRef<HTMLDivElement>;

  // ── テンプレートへ公開する状態 Signal ─────────────────────────────────────
  protected readonly isLoading = signal(true);
  protected readonly hasError = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly currentStep = signal<
    'idle' | 'token' | 'embed' | 'resize' | 'done'
  >('idle');

  /**
   * ResizeObserver が mountPoint のサイズを計測するたびに更新する Signal。
   * afterRenderEffect がこの Signal を自動追跡し、iframe へ DOM 反映する。
   *
   * ポイント: ResizeObserver コールバックは "Signal への書き込みだけ" を行う。
   *           DOM 操作は Angular の描画サイクルに同期した afterRenderEffect に任せる。
   */
  private readonly iframeSize = signal<{ width: number; height: number } | null>(null);

  /** embedDashboard() が DOM に生成した iframe 要素への参照 */
  private iframeEl: HTMLIFrameElement | null = null;

  // ── DI ───────────────────────────────────────────────────────────────────
  private readonly supersetService = inject(SupersetService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly dashboardId = '974e943f-f298-4c77-b56f-5bb1bd71ce42';
  private readonly supersetDomain = 'http://localhost:8088';

  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    // ① afterNextRender: DOM 書き込みフェーズ完了後に一度だけ実行
    //    → AfterViewInit の代替
    //    → Promise ベースで逐次処理するため RxJS パイプラインが不要
    afterNextRender(() => {
      void this.initDashboard();
    });

    // ② afterRenderEffect: iframeSize Signal が変化した描画サイクルで自動再実行
    //    → iframeSize() を呼ぶだけで依存が自動登録される (明示的な subscribe 不要)
    //    → DOM 書き込みはここに集約し、ResizeObserver コールバックでは行わない
    afterRenderEffect(() => {
      const size = this.iframeSize(); // ← この Signal を追跡
      if (this.iframeEl && size) {
        this.iframeEl.style.width = `${size.width}px`;
        this.iframeEl.style.height = `${size.height}px`;
        this.currentStep.set('done');
      }
    });

    // ③ DestroyRef.onDestroy: OnDestroy インターフェース不要でクリーンアップ登録
    //    → inject() で取得できるため class 定義を汚染しない
    this.destroyRef.onDestroy(() => {
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      if (this.dashboardContainer?.nativeElement) {
        this.dashboardContainer.nativeElement.innerHTML = '';
      }
    });
  }

  /**
   * 3 ステップを async/await で直列実行する。
   *
   *  Step 1: ゲストトークン取得  — firstValueFrom() で Observable を一度だけ待つ
   *  Step 2: Embedded SDK 実行  — embedDashboard() → iframe 参照取得
   *  Step 3: リサイズ監視開始   — ResizeObserver → iframeSize Signal に書き込み
   *                              実際の DOM 反映は afterRenderEffect が担当
   */
  private async initDashboard(): Promise<void> {
    const mountPoint = this.dashboardContainer.nativeElement;

    try {
      // ── Step 1: ゲストトークン取得 ─────────────────────────────────────
      this.currentStep.set('token');
      const guestToken = await firstValueFrom(
        this.supersetService.getGuestToken(this.dashboardId),
      );
      console.log('[Lifecycle版] guestToken 取得:', guestToken.slice(0, 20) + '...');

      // ── Step 2: Embedded SDK 実行 ───────────────────────────────────────
      this.currentStep.set('embed');
      await embedDashboard({
        id: this.dashboardId,
        supersetDomain: this.supersetDomain,
        mountPoint,
        // SDK がトークン期限切れ時に呼び出すコールバック
        fetchGuestToken: () =>
          firstValueFrom(this.supersetService.getGuestToken(this.dashboardId)),
        dashboardUiConfig: {
          hideTitle: false,
          hideChartControls: false,
          hideTab: false,
        },
      });

      this.iframeEl = mountPoint.querySelector('iframe');
      this.isLoading.set(false);
      this.currentStep.set('resize');

      // ── Step 3: ResizeObserver → Signal への書き込みのみ ────────────────
      //    DOM 反映は afterRenderEffect に委譲する。
      //    これにより Angular の変更検知サイクルと同期した安全な書き込みになる。
      this.resizeObserver = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect;
        if (rect) {
          this.iframeSize.set({ width: rect.width, height: rect.height });
          // ↑ Signal に書き込むだけ。DOM 操作は afterRenderEffect が行う。
        }
      });
      this.resizeObserver.observe(mountPoint);

    } catch (err: unknown) {
      console.error('[Lifecycle版] 初期化エラー:', err);
      this.isLoading.set(false);
      this.hasError.set(true);
      this.errorMessage.set(
        'ダッシュボードの読み込みに失敗しました。Superset と BFF が起動しているか確認してください。',
      );
    }
  }
}
