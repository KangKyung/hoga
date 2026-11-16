import type { CreateServerOptions } from '../src/app.js';
import { CORE_SYMBOLS } from '../src/market/symbols.js';

/**
 * 서버 시험은 핵심 5종목으로 띄운다. 기본 120종목이면 시작할 때 과거 봉을 만들고 모의 주문을 낼 때마다
 * 24배 일을 해서, CI에서 빌드와 겹치면 시간 제한을 넘긴다(종목 수와 무관한 동작만 시험한다).
 */
export const TEST_OPTIONS: CreateServerOptions = { market: { symbols: CORE_SYMBOLS } };
