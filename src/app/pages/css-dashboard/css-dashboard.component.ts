/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CSS サイズ制御パターン版 ダッシュボードページ
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 【検証内容】
 *  - ResizeObserver によるリサイズ処理を一切行わず、
 *    CSS (width: 100% !important; height: 100% !important) だけで
 *    iframe のサイズを親コンテナに追従させられるかを検証する。
 *
 * 【RxJS版との差分】
 *  - Step 4 (fromResizeObserver + switchMap) を完全に削除
 *  - Subject / takeUntil も不要のため削除
 *  - OnDestroy は iframe DOM クリーンアップのためのみ残す
 *  - ngAfterViewInit でトークン取得 → embed を直列実行（RxJS版と同じ構造）
 *
 * 【CSS側の対応】
 *  - ::ng-deep iframe { width: 100% !important; height: 100% !important; }
 *    を追加することで SDK が注入する固定ピクセルサイズを上書きする
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
import { switchMap, tap, catchError, from, defer } from 'rxjs';
import { EMPTY, of } from 'rxjs';
import { embedDashboard } from '@superset-ui/embedded-sdk';
import { SupersetService } from '../../services/superset.service';

@Component({
  selector: 'app-css-dashboard',
  standalone: true,
  templateUrl: './css-dashboard.component.html',
  styleUrl: './css-dashboard.component.scss',
  host: { style: 'display: block; width: 100%; height: 100%;' },
})
export class CssDashboardComponent implements AfterViewInit, OnDestroy {
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

  constructor(private readonly supersetService: SupersetService) { }

  // ── AfterViewInit: DOM 確定後にトークン取得 → embed を直列実行 ────────────
  ngAfterViewInit(): void {
    const mountPoint = this.dashboardContainer.nativeElement;

    // Step1: トークン取得 → Step2: embed のみ。ResizeObserver は不要。
    of({ dashboardId: this.dashboardId, mountPoint })
      .pipe(
        tap(() => {
          this.currentStep.set('token');
          this.isLoading.set(true);
          this.hasError.set(false);
        }),

        // ── Step 1: BFF へゲストトークン取得 ─────────────────────────────
        switchMap((ctx) =>
          this.supersetService.getGuestToken(ctx.dashboardId).pipe(
            tap(() => this.currentStep.set('embed')),
            switchMap((guestToken) =>
              // ── Step 2: Embedded SDK 実行 ───────────────────────────────
              defer(() =>
                from(
                  embedDashboard({
                    id: ctx.dashboardId,
                    supersetDomain: this.supersetDomain,
                    mountPoint: ctx.mountPoint,
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
              ),
            ),
          ),
        ),

        tap(() => {
          this.isLoading.set(false);
          this.currentStep.set('done');
          // ResizeObserver なし: CSS の width/height 100% !important で制御
        }),

        catchError((err: unknown) => {
          console.error('[CSS版] パイプラインエラー:', err);
          this.isLoading.set(false);
          this.hasError.set(true);
          this.errorMessage.set(
            'ダッシュボードの読み込みに失敗しました。Superset と BFF が起動しているか確認してください。',
          );
          return EMPTY;
        }),
      )
      .subscribe();
  }

  // ── OnDestroy: DOM クリーンアップのみ ─────────────────────────────────────
  ngOnDestroy(): void {
    if (this.dashboardContainer?.nativeElement) {
      this.dashboardContainer.nativeElement.innerHTML = '';
    }
  }
}
