import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs/operators';
import { DashboardComponent } from '../../components/dashboard/dashboard.component';

/**
 * ルーティング層のページコンポーネント。
 *
 * 責務:
 *  - ActivatedRoute からパスパラメータ (:id) を取得する
 *  - DashboardComponent へ dashboardId を渡す
 *  - ルーティング固有の UI (パンくず等) をここで管理する
 *
 * DashboardComponent 自体はルーティング知識を持たないため、
 * どこに埋め込んでも再利用できる。
 */
@Component({
  selector: 'app-dashboard-page',
  standalone: true,
  imports: [DashboardComponent],
  templateUrl: './dashboard-page.component.html',
  styleUrl: './dashboard-page.component.scss',
})
export class DashboardPageComponent {
  private readonly route = inject(ActivatedRoute);

  /**
   * ルートパラメータ :id を Signal として保持する。
   * toSignal() は subscribe/unsubscribe を自動管理するため
   * OnDestroy での手動クリーンアップが不要。
   */
  readonly dashboardId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' },
  );
}
