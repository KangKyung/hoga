// 공용 C++ 코어(N-API). CommonJS 네이티브 모듈이라 default import 후 구조 분해한다.
import core from '@hoga/core-node';

export const {
  MatchingEngine,
  CandleSeries,
  coreVersion,
  tickSize,
  roundToTick,
  priceLimits,
  validateOrder,
  checkAccount,
  maxOrderQty,
  checkVi,
  phaseAt,
} = core;
export type {
  CandleRow,
  ExecutionResult,
  Level,
  LevelChange,
  OrderRequest,
  OrderStatus,
  RejectReason,
  Side,
  TradingMode,
  MarketPhase,
  ViKind,
  AccountLimits,
} from '@hoga/core-node';
