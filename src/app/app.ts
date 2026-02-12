import { Component } from '@angular/core';
import { DashboardComponent } from './components/dashboard/dashboard.component';

@Component({
  selector: 'app-root',
  imports: [DashboardComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  // Superset のダッシュボード ID をここに設定してください
  // Superset の UI で確認: ダッシュボード > ... > ダッシュボード情報 > UUID
  readonly dashboardId = 'abbb00fa-f7c9-4162-9c88-4a1ab1af1998';
}
