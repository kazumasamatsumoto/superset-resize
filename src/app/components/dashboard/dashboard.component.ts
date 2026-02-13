import {
  Component,
  DestroyRef,
  ElementRef,
  Input,
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
  selector: 'app-dashboard',
  standalone: true,
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
  @Input() dashboardId!: string;

  @ViewChild('dashboardContainer', { static: true })
  private readonly dashboardContainer!: ElementRef<HTMLDivElement>;

  // ── テンプレートへ公開する状態 Signal ───────────────────────────────
  protected readonly isLoading  = signal(true);
  protected readonly hasError   = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly currentStep = signal<
    'idle' | 'token' | 'embed' | 'resize' | 'done'
  >('idle');

  // ── 内部状態 Signal ─────────────────────────────────────────────────
  /**
   * ResizeObserver が mountPoint のサイズを計測するたびに更新する。
   * afterRenderEffect がこの Signal を追跡し、iframe へ反映する。
   */
  private readonly iframeSize = signal<{ width: number; height: number } | null>(null);

  /** embedDashboard() が DOM に生成した iframe 要素 */
  private iframeEl: HTMLIFrameElement | null = null;

  // ── DI ─────────────────────────────────────────────────────────────
  private readonly supersetService = inject(SupersetService);
  private readonly destroyRef      = inject(DestroyRef);

  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    // ① DOM 書き込みフェーズ完了後に一度だけ SDK 初期化を実行する。
    //    AfterViewInit の代替。Promise ベースで逐次処理するため
    //    RxJS パイプラインは不要。
    afterNextRender(() => {
      void this.initDashboard();
    });

    // ② iframeSize Signal が変化するたびに DOM へサイズを反映する。
    //    afterRenderEffect は内部で参照した Signal を自動追跡し、
    //    変化があった描画サイクルの書き込みフェーズで再実行される。
    //    ResizeObserver のコールバックは Signal への書き込みのみ行い、
    //    実際の DOM 操作はここに集約する。
    afterRenderEffect(() => {
      const size = this.iframeSize(); // ← この Signal を追跡
      if (this.iframeEl && size) {
        this.iframeEl.style.width  = `${size.width}px`;
        this.iframeEl.style.height = `${size.height}px`;
        this.currentStep.set('done');
      }
    });

    // ③ DestroyRef でクリーンアップを登録。
    //    ngOnDestroy インターフェースの実装が不要になる。
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
   *  Step 1: ゲストトークン取得  — BFF の HTTP GET
   *  Step 2: Embedded SDK 実行  — embedDashboard() → iframe 参照取得
   *  Step 3: iframe リサイズ監視 — ResizeObserver → iframeSize Signal に書き込み
   *                               実際の DOM 反映は afterRenderEffect が担当
   */
  private async initDashboard(): Promise<void> {
    if (!this.dashboardId) {
      this.hasError.set(true);
      this.errorMessage.set('dashboardId が指定されていません。');
      this.isLoading.set(false);
      return;
    }

    const mountPoint = this.dashboardContainer.nativeElement;

    try {
      // ── Step 1: ゲストトークン取得 ────────────────────────────────
      this.currentStep.set('token');
      const guestToken = await firstValueFrom(
        this.supersetService.getGuestToken(this.dashboardId),
      );

      // ── Step 2: Embedded SDK 実行 ─────────────────────────────────
      this.currentStep.set('embed');
      await embedDashboard({
        id: this.dashboardId,
        supersetDomain: 'http://localhost:8088',
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

      // ── Step 3: ResizeObserver → Signal への書き込みのみ ──────────
      //    DOM 反映は afterRenderEffect に委譲することで、
      //    Angular の変更検知サイクルと同期した安全な書き込みになる。
      this.resizeObserver = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect;
        if (rect) {
          this.iframeSize.set({ width: rect.width, height: rect.height });
        }
      });
      this.resizeObserver.observe(mountPoint);

    } catch (err: unknown) {
      console.error('[Dashboard] 初期化エラー:', err);
      this.isLoading.set(false);
      this.hasError.set(true);
      this.errorMessage.set(
        'ダッシュボードの読み込みに失敗しました。Superset と BFF が起動しているか確認してください。',
      );
    }
  }
}
