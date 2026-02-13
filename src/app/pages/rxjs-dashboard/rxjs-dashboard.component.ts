/**
 * ─────────────────────────────────────────────────────────────────────────────
 * RxJS パターン版 ダッシュボードページ
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 【旧来のスタイルの特徴】
 *  - AfterViewInit   : DOM 確定後の処理エントリポイント
 *  - OnDestroy       : クリーンアップのための専用ライフサイクル
 *  - Subject + takeUntil : ストリームの購読解除パターン
 *  - fromResizeObserver  : ResizeObserver を Observable に変換するラッパー
 *  - switchMap / tap / catchError : 処理を一本の RxJS パイプラインで記述
 *
 * 【利点】
 *  - 非同期処理が宣言的に一か所にまとまる
 *  - debounceTime / distinctUntilChanged などの RxJS オペレータが使いやすい
 *
 * 【課題】
 *  - Subject / takeUntil の定型コードが多い
 *  - パイプラインが長くなると追いづらい
 *  - toPromise() は非推奨 (→ firstValueFrom 推奨)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  signal,
} from '@angular/core';
import {
  EMPTY,
  Observable,
  Subject,
  defer,
  from,
  of,
} from 'rxjs';
import {
  catchError,
  debounceTime,
  distinctUntilChanged,
  map,
  switchMap,
  takeUntil,
  tap,
} from 'rxjs/operators';
import { embedDashboard } from '@superset-ui/embedded-sdk';
import { SupersetService } from '../../services/superset.service';

/** ストリーム上で受け渡すコンテキスト型 */
interface EmbedContext {
  dashboardId: string;
  mountPoint: HTMLDivElement;
  guestToken: string;
  iframe: HTMLIFrameElement | null;
}

/**
 * ResizeObserver を RxJS Observable に変換するファクトリ関数。
 * unsubscribe 時に observer.disconnect() を自動呼び出しする。
 */
function fromResizeObserver(target: Element): Observable<ResizeObserverEntry> {
  return new Observable<ResizeObserverEntry>((subscriber) => {
    const observer = new ResizeObserver((entries) => {
      entries.forEach((entry) => subscriber.next(entry));
    });
    observer.observe(target);
    // unsubscribe 時のティアダウン
    return () => observer.disconnect();
  });
}

@Component({
  selector: 'app-rxjs-dashboard',
  standalone: true,
  templateUrl: './rxjs-dashboard.component.html',
  styleUrl: './rxjs-dashboard.component.scss',
})
export class RxjsDashboardComponent implements AfterViewInit, OnDestroy {
  // ── DOM 参照 ──────────────────────────────────────────────────────────────
  @ViewChild('dashboardContainer', { static: true })
  private readonly dashboardContainer!: ElementRef<HTMLDivElement>;

  // ── テンプレートへ公開する状態 Signal ─────────────────────────────────────
  protected readonly isLoading    = signal(true);
  protected readonly hasError     = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly currentStep  = signal<
    'idle' | 'token' | 'embed' | 'resize' | 'done'
  >('idle');

  // ── 定数 ─────────────────────────────────────────────────────────────────
  private readonly dashboardId    = 'abbb00fa-f7c9-4162-9c88-4a1ab1af1998';
  private readonly supersetDomain = 'http://localhost:8088';

  /**
   * コンポーネント破棄時に全ストリームを完了させるトリガー。
   * OnDestroy で next() → complete() を呼ぶことで
   * takeUntil が受け取りすべての購読を自動解除する。
   */
  private readonly destroy$ = new Subject<void>();

  constructor(private readonly supersetService: SupersetService) {}

  // ── AfterViewInit: DOM 確定後に RxJS パイプラインを起動 ────────────────────
  ngAfterViewInit(): void {
    this.startPipeline();
  }

  // ── OnDestroy: Subject を完了させてストリームをすべて解除 ──────────────────
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    // ResizeObserver は fromResizeObserver のティアダウンで disconnect 済み
    if (this.dashboardContainer?.nativeElement) {
      this.dashboardContainer.nativeElement.innerHTML = '';
    }
  }

  /**
   * 4 ステップを RxJS パイプラインとして直列に処理する。
   *
   *  Step 1: 初期化            — of() で初期コンテキストを発行
   *  Step 2: ゲストトークン取得 — BFF の HTTP GET
   *  Step 3: Embedded SDK 実行 — embedDashboard() → iframe 参照取得
   *  Step 4: iframe リサイズ   — ResizeObserver で継続監視
   */
  private startPipeline(): void {
    const mountPoint = this.dashboardContainer.nativeElement;

    // ── Step 1: 初期コンテキストを流す ────────────────────────────────────
    of({ dashboardId: this.dashboardId, mountPoint })
      .pipe(
        tap(() => {
          this.currentStep.set('token');
          this.isLoading.set(true);
          this.hasError.set(false);
        }),

        // ── Step 2: BFF へゲストトークン取得 ─────────────────────────────
        switchMap((ctx) =>
          this.supersetService.getGuestToken(ctx.dashboardId).pipe(
            map((guestToken): EmbedContext => ({
              ...ctx,
              guestToken,
              iframe: null,
            })),
          ),
        ),
        tap(() => this.currentStep.set('embed')),

        // ── Step 3: Embedded SDK 実行 → iframe 参照取得 ───────────────────
        switchMap((ctx) =>
          // defer で subscribe 毎に Promise を生成し、from で Observable 化する
          defer(() =>
            from(
              embedDashboard({
                id: ctx.dashboardId,
                supersetDomain: this.supersetDomain,
                mountPoint: ctx.mountPoint,
                // SDK がトークン期限切れ時に再取得するコールバック
                fetchGuestToken: () =>
                  this.supersetService
                    .getGuestToken(ctx.dashboardId)
                    .toPromise() as Promise<string>,
                dashboardUiConfig: {
                  hideTitle: false,
                  hideChartControls: false,
                  hideTab: false,
                },
              }),
            ),
          ).pipe(
            map((): EmbedContext => ({
              ...ctx,
              iframe: ctx.mountPoint.querySelector('iframe'),
            })),
          ),
        ),
        tap(() => {
          this.isLoading.set(false);
          this.currentStep.set('resize');
        }),

        // ── Step 4: iframe リサイズ監視 (継続ストリーム) ──────────────────
        switchMap((ctx) =>
          fromResizeObserver(ctx.mountPoint).pipe(
            debounceTime(100),
            map((entry) => entry.contentRect),
            distinctUntilChanged(
              (a, b) => a.width === b.width && a.height === b.height,
            ),
            tap(({ width, height }) => {
              if (ctx.iframe) {
                ctx.iframe.style.width  = `${width}px`;
                ctx.iframe.style.height = `${height}px`;
              }
              this.currentStep.set('done');
            }),
          ),
        ),

        catchError((err: unknown) => {
          console.error('[RxJS版] パイプラインエラー:', err);
          this.isLoading.set(false);
          this.hasError.set(true);
          this.errorMessage.set(
            'ダッシュボードの読み込みに失敗しました。Superset と BFF が起動しているか確認してください。',
          );
          return EMPTY;
        }),

        // destroy$ が発火したら全オペレータの購読を自動解除
        takeUntil(this.destroy$),
      )
      .subscribe();
  }
}
