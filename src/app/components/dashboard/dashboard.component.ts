import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnDestroy,
  ViewChild,
  signal,
} from '@angular/core';
import { embedDashboard } from '@superset-ui/embedded-sdk';
import { SupersetService } from '../../services/superset.service';
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
    return () => observer.disconnect();
  });
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements AfterViewInit, OnDestroy {
  @Input() dashboardId!: string;
  @ViewChild('dashboardContainer', { static: true })
  dashboardContainer!: ElementRef<HTMLDivElement>;

  protected readonly isLoading = signal(true);
  protected readonly hasError = signal(false);
  protected readonly errorMessage = signal('');
  /** 現在の処理ステップをテンプレートに公開 */
  protected readonly currentStep = signal<
    'idle' | 'token' | 'embed' | 'resize' | 'done'
  >('idle');

  private readonly supersetDomain = 'http://localhost:8088';
  /** コンポーネント破棄時に全ストリームを完了させるトリガー */
  private readonly destroy$ = new Subject<void>();

  constructor(private readonly supersetService: SupersetService) {}

  ngAfterViewInit(): void {
    if (!this.dashboardId) {
      this.hasError.set(true);
      this.errorMessage.set('dashboardId が指定されていません。');
      this.isLoading.set(false);
      return;
    }

    this.startPipeline();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    // ResizeObserver は fromResizeObserver の teardown で disconnect 済み
    if (this.dashboardContainer?.nativeElement) {
      this.dashboardContainer.nativeElement.innerHTML = '';
    }
  }

  /**
   * 4 ステップを RxJS パイプラインとして直列に処理する。
   *
   *  Step 1: アクセス          — of() で初期コンテキストを発行
   *  Step 2: ゲストトークン取得 — BFF の HTTP GET
   *  Step 3: Embedded SDK 実行 — embedDashboard() → iframe 参照取得
   *  Step 4: iframe リサイズ   — ResizeObserver で継続監視
   */
  private startPipeline(): void {
    const mountPoint = this.dashboardContainer.nativeElement;

    // ── Step 1: アクセス ──────────────────────────────────────────────
    of({ dashboardId: this.dashboardId, mountPoint })
      .pipe(
        tap(() => {
          this.currentStep.set('token');
          this.isLoading.set(true);
          this.hasError.set(false);
        }),

        // ── Step 2: BFF へゲストトークン取得 ─────────────────────────
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

        // ── Step 3: Embedded SDK 実行 → iframe 参照取得 ───────────────
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
            // embedDashboard 完了後、DOM に生成された iframe を取得してコンテキストへ追加
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

        // ── Step 4: iframe リサイズ監視 (継続ストリーム) ─────────────
        switchMap((ctx) =>
          fromResizeObserver(ctx.mountPoint).pipe(
            debounceTime(100),
            map((entry) => entry.contentRect),
            distinctUntilChanged(
              (a, b) => a.width === b.width && a.height === b.height,
            ),
            tap(({ width, height }) => {
              if (ctx.iframe) {
                ctx.iframe.style.width = `${width}px`;
                ctx.iframe.style.height = `${height}px`;
              }
              this.currentStep.set('done');
            }),
          ),
        ),

        catchError((err: unknown) => {
          console.error('[Dashboard] パイプラインエラー:', err);
          this.isLoading.set(false);
          this.hasError.set(true);
          this.errorMessage.set(
            'ダッシュボードの読み込みに失敗しました。Superset と BFF が起動しているか確認してください。',
          );
          return EMPTY;
        }),

        takeUntil(this.destroy$),
      )
      .subscribe();
  }
}
