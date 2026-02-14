import { Routes } from '@angular/router';

export const routes: Routes = [
  // / → RxJS版ページへリダイレクト
  {
    path: '',
    redirectTo: 'rxjs',
    pathMatch: 'full',
  },

  // /rxjs — RxJS パターン版 (AfterViewInit + Subject/takeUntil)
  {
    path: 'rxjs',
    loadComponent: () =>
      import('./pages/rxjs-dashboard/rxjs-dashboard.component').then(
        (m) => m.RxjsDashboardComponent,
      ),
    title: 'RxJS パターン版',
  },

  // /lifecycle — Angular ライフサイクル版 (afterNextRender + afterRenderEffect)
  {
    path: 'lifecycle',
    loadComponent: () =>
      import('./pages/lifecycle-dashboard/lifecycle-dashboard.component').then(
        (m) => m.LifecycleDashboardComponent,
      ),
    title: 'ライフサイクル パターン版',
  },

  // /css — CSS サイズ制御パターン版 (ResizeObserver 不使用)
  {
    path: 'css',
    loadComponent: () =>
      import('./pages/css-dashboard/css-dashboard.component').then(
        (m) => m.CssDashboardComponent,
      ),
    title: 'CSS サイズ制御パターン版',
  },

  // 未マッチは / へフォールバック
  {
    path: '**',
    redirectTo: '',
  },
];
