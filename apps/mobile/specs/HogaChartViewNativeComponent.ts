import type {CodegenTypes, HostComponent, ViewProps} from 'react-native';
import {codegenNativeComponent} from 'react-native';

/** 길게 눌러 십자선을 움직일 때. active=false면 손을 뗐다. */
export type CrosshairEvent = Readonly<{
  active: boolean;
  start: CodegenTypes.Double;
  open: CodegenTypes.Double;
  high: CodegenTypes.Double;
  low: CodegenTypes.Double;
  close: CodegenTypes.Double;
  volume: CodegenTypes.Double;
}>;

/**
 * 네이티브 캔들 차트(Fabric 컴포넌트).
 * - iOS: Objective-C++ + CoreGraphics, Android: Kotlin + Canvas
 * - 데이터는 props로 받지 않는다. 뷰가 C++ MarketClient의 봉을 직접 읽어 화면 주사율에 맞춰 그린다.
 *   props는 무엇을 그릴지(종목·구간·표시 옵션)만 정한다.
 * - 배치 계산(보이는 구간·가격 범위·이동평균·격자)은 C++ hoga::chart::layout 한 벌.
 */
export interface NativeProps extends ViewProps {
  symbol: string;
  /** 봉 구간(ms). 60000 = 1분, 300000 = 5분 */
  intervalMs?: CodegenTypes.WithDefault<CodegenTypes.Int32, 60000>;
  /** 처음 보일 봉 수(핀치로 바꿀 수 있다) */
  initialBars?: CodegenTypes.WithDefault<CodegenTypes.Int32, 60>;
  showVolume?: CodegenTypes.WithDefault<boolean, true>;
  showMA?: CodegenTypes.WithDefault<boolean, true>;
  onCrosshair?: CodegenTypes.DirectEventHandler<CrosshairEvent>;
}

export default codegenNativeComponent<NativeProps>('HogaChartView') as HostComponent<NativeProps>;
