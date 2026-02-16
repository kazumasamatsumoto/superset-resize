/**
 * ─────────────────────────────────────────────────────────────────────────────
 * afterNextRender パターン版 ダッシュボードページ
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 【検証内容】
 *  - Angular 16.2+ の afterNextRender を使用し、
 *    AfterViewInit を implements せずに DOM 確定後の処理を記述する。
 *
 * 【ライフサイクルの切り分け】
 *  - ngOnInit       : DOM 不要な処理（ゲストトークン取得 HTTP リクエスト）を先行開始
 *  - afterNextRender: コンストラクタ内で登録。次の1回のレンダリング後に
 *                     mountPoint を取得して embedDashboard を実行
 *  - Subject(guestToken$) で ngOnInit と afterNextRender を RxJS チェーンで接続
 *
 * 【AfterViewInit との違い】
 *  - implements AfterViewInit が不要
 *  - コンストラクタ内（インジェクションコンテキスト内）で登録する関数ベースの API
 *  - SSR 時は自動スキップされるためブラウザ限定処理を安全に記述できる
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  afterNextRender,
  signal,
} from '@angular/core';
import { Subject, from, defer, EMPTY } from 'rxjs';
import { switchMap, tap, catchError, takeUntil } from 'rxjs';
import { embedDashboard } from '@superset-ui/embedded-sdk';
import { SupersetService } from '../../services/superset.service';

@Component({
  selector: 'app-after-next-render-dashboard',
  standalone: true,
  templateUrl: './after-next-render-dashboard.component.html',
  styleUrl: './after-next-render-dashboard.component.scss',
  host: { style: 'display: block; width: 100%; height: 100%;' },
})
export class AfterNextRenderDashboardComponent implements OnInit, OnDestroy {
  // ── DOM 参照 ──────────────────────────────────────────────────────────────
  @ViewChild('dashboardContainer', { static: true })
  private readonly dashboardContainer!: ElementRef<HTMLDivElement>;

  // ── テンプレートへ公開する状態 Signal ─────────────────────────────────────
  protected readonly isLoading = signal(true);
  protected readonly hasError = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly currentStep = signal<'idle' | 'token' | 'embed' | 'done'>('idle');

  // ── 定数 ─────────────────────────────────────────────────────────────────
  private readonly dashboardId = '974e943f-f298-4c77-b56f-5bb1bd71ce42';
  private readonly supersetDomain = 'http://localhost:8088';

  // ── ライフサイクル間の橋渡し Subject ─────────────────────────────────────
  // ngOnInit で取得したトークンを afterNextRender 側のストリームへ流す
  private readonly guestToken$ = new Subject<string>();
  private readonly destroy$ = new Subject<void>();

  constructor(private readonly supersetService: SupersetService) {
    // ── afterNextRender: 次の1回のレンダリング後に DOM 操作を実行 ────────────
    // インジェクションコンテキスト内（コンストラクタ）で登録する必要がある
    // SSR 時は自動スキップされる（AfterViewInit との大きな違い）
    afterNextRender(() => {
      const mountPoint = this.dashboardContainer.nativeElement;

      // ngOnInit で先行取得したトークンを受け取って embed 実行
      this.guestToken$
        .pipe(
          tap(() => this.currentStep.set('embed')),

          // ── Step 2: Embedded SDK 実行 ─────────────────────────────────────
          switchMap(() =>
            defer(() =>
              from(
                embedDashboard({
                  id: this.dashboardId,
                  supersetDomain: this.supersetDomain,
                  mountPoint,
                  fetchGuestToken: () =>
                    this.supersetService
                      .getGuestToken(this.dashboardId)
                      .toPromise() as Promise<string>,
                  dashboardUiConfig: {
                    hideTitle: false,
                    hideChartControls: false,
                    hideTab: false,
                  },
                }),
              ),
            ),
          ),

          tap(() => {
            this.isLoading.set(false);
            this.currentStep.set('done');
          }),

          catchError((err: unknown) => {
            console.error('[afterNextRender版] embed エラー:', err);
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
    });
  }

  // ── ngOnInit: DOM 不要なトークン取得を先行開始 ────────────────────────────
  ngOnInit(): void {
    this.currentStep.set('token');
    this.isLoading.set(true);
    this.hasError.set(false);

    this.supersetService
      .getGuestToken(this.dashboardId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (token) => this.guestToken$.next(token),
        error: (err: unknown) => {
          console.error('[afterNextRender版] トークン取得エラー:', err);
          this.isLoading.set(false);
          this.hasError.set(true);
          this.errorMessage.set(
            'ダッシュボードの読み込みに失敗しました。Superset と BFF が起動しているか確認してください。',
          );
        },
      });
  }

  // ── OnDestroy: ストリーム完了 & DOM クリーンアップ ─────────────────────────
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();

    if (this.dashboardContainer?.nativeElement) {
      this.dashboardContainer.nativeElement.innerHTML = '';
    }
  }
}
