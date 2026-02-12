import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable({
  providedIn: 'root',
})
export class SupersetService {
  // NestJS BFF の URL
  private readonly bffUrl = 'http://localhost:3000';

  constructor(private readonly http: HttpClient) {}

  /**
   * BFF 経由でゲストトークンを取得する
   */
  getGuestToken(dashboardId: string): Observable<string> {
    return this.http
      .get<{ token: string }>(`${this.bffUrl}/superset/guest-token/${dashboardId}`)
      .pipe(map((response) => response.token));
  }
}
