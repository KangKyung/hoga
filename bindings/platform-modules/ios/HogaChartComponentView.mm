// 네이티브 캔들 차트(iOS, Fabric 컴포넌트, Objective-C++ + CoreGraphics).
//
// - 데이터: C++ MarketClient의 봉을 hoga::chartsource로 직접 읽는다(JS 경유 없음).
// - 배치: C++ hoga::chart::layout (Android와 같은 계산). 여기서는 받은 좌표대로 그리기만 한다.
// - 다시 그리기: CADisplayLink로 매 프레임 봉 버전만 확인하고, 바뀌었거나 제스처가 있을 때만 그린다.
// - 제스처: 핀치(확대·축소), 가로 드래그(과거로 스크롤), 길게 누르기(십자선 → onCrosshair 이벤트).
#import <React/RCTViewComponentView.h>
#import <UIKit/UIKit.h>

#import <react/renderer/components/AppSpecs/ComponentDescriptors.h>
#import <react/renderer/components/AppSpecs/EventEmitters.h>
#import <react/renderer/components/AppSpecs/Props.h>
#import <react/renderer/components/AppSpecs/RCTComponentViewHelpers.h>

#include <optional>
#include <string>
#include <vector>

#include "ChartDataSource.h"
#include "hoga/chart_layout.hpp"

using namespace facebook::react;

static UIColor *Hex(uint32_t rgb, CGFloat alpha = 1)
{
  return [UIColor colorWithRed:((rgb >> 16) & 0xFF) / 255.0
                         green:((rgb >> 8) & 0xFF) / 255.0
                          blue:(rgb & 0xFF) / 255.0
                         alpha:alpha];
}

static NSString *FormatPrice(hoga::Price price)
{
  static NSNumberFormatter *formatter = [] {
    NSNumberFormatter *f = [NSNumberFormatter new];
    f.numberStyle = NSNumberFormatterDecimalStyle;
    f.locale = [NSLocale localeWithLocaleIdentifier:@"ko_KR"];
    return f;
  }();
  return [formatter stringFromNumber:@(price)];
}

static NSString *FormatTime(int64_t ms)
{
  static NSDateFormatter *formatter = [] {
    NSDateFormatter *f = [NSDateFormatter new];
    f.dateFormat = @"HH:mm";
    return f;
  }();
  return [formatter stringFromDate:[NSDate dateWithTimeIntervalSince1970:ms / 1000.0]];
}

@class HogaChartDrawView;

@protocol HogaChartDrawViewDelegate <NSObject>
- (void)chartView:(HogaChartDrawView *)view didMoveCrosshairTo:(std::optional<hoga::Candle>)candle;
@end

@interface HogaChartDrawView : UIView <UIGestureRecognizerDelegate>
@property (nonatomic, weak) id<HogaChartDrawViewDelegate> delegate;
@property (nonatomic, assign) BOOL showVolume;
@property (nonatomic, assign) BOOL showMA;
- (void)setSymbol:(std::string)symbol intervalMs:(int64_t)intervalMs initialBars:(int)initialBars;
@end

@implementation HogaChartDrawView {
  std::string _symbol;
  int64_t _intervalMs;
  hoga::chart::Window _window;
  hoga::chart::Window _gestureStart;
  std::vector<hoga::Candle> _bars;
  hoga::chart::Layout _layout;
  uint64_t _version;
  BOOL _dirty;
  std::optional<CGFloat> _crosshairX;
  CADisplayLink *_displayLink;
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    self.backgroundColor = UIColor.whiteColor;
    self.contentMode = UIViewContentModeRedraw;
    _intervalMs = 60'000;
    _window = {60, 0};
    _showVolume = YES;
    _showMA = YES;
    _version = UINT64_MAX;

    UIPinchGestureRecognizer *pinch = [[UIPinchGestureRecognizer alloc] initWithTarget:self action:@selector(onPinch:)];
    UIPanGestureRecognizer *pan = [[UIPanGestureRecognizer alloc] initWithTarget:self action:@selector(onPan:)];
    pan.delegate = self;
    UILongPressGestureRecognizer *press =
        [[UILongPressGestureRecognizer alloc] initWithTarget:self action:@selector(onLongPress:)];
    press.minimumPressDuration = 0.25;
    for (UIGestureRecognizer *g in @[ pinch, pan, press ]) [self addGestureRecognizer:g];
  }
  return self;
}

- (void)setSymbol:(std::string)symbol intervalMs:(int64_t)intervalMs initialBars:(int)initialBars
{
  const bool changed = symbol != _symbol || intervalMs != _intervalMs;
  _symbol = std::move(symbol);
  _intervalMs = intervalMs > 0 ? intervalMs : 60'000;
  if (changed) {
    _window = {initialBars > 0 ? initialBars : 60, 0};
    _version = UINT64_MAX;  // 다음 프레임에 새로 읽는다
  }
}

- (void)setShowVolume:(BOOL)showVolume
{
  _showVolume = showVolume;
  _dirty = YES;
}

- (void)setShowMA:(BOOL)showMA
{
  _showMA = showMA;
  _dirty = YES;
}

// 화면에 붙어 있을 때만 프레임 콜백을 돌린다
- (void)didMoveToWindow
{
  [super didMoveToWindow];
  [_displayLink invalidate];
  _displayLink = nil;
  if (self.window) {
    _displayLink = [CADisplayLink displayLinkWithTarget:self selector:@selector(onFrame)];
    [_displayLink addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
  }
}

- (void)onFrame
{
  if (_symbol.empty()) return;
  const auto version = hoga::chartsource::version(_symbol);
  if (version != _version) {
    _version = version;
    _bars = hoga::chartsource::candles(_symbol, _intervalMs == 60'000 ? 0 : _intervalMs, 600);
    _dirty = YES;
  }
  if (_dirty) {
    _dirty = NO;
    [self setNeedsDisplay];
  }
}

- (hoga::chart::Viewport)viewport
{
  hoga::chart::Viewport vp;
  vp.width = static_cast<float>(self.bounds.size.width);
  vp.height = static_cast<float>(self.bounds.size.height);
  vp.volumeRatio = _showVolume ? 0.22F : 0;
  vp.labelHeight = 16;  // 마지막가 표시 높이(pt)
  return vp;
}

#pragma mark - 그리기

- (void)drawRect:(CGRect)rect
{
  CGContextRef ctx = UIGraphicsGetCurrentContext();
  _layout = hoga::chart::layout(_bars, [self viewport], _window, _showMA);
  _window = hoga::chart::clampWindow(_window, _bars.size());
  const auto &l = _layout;
  const CGFloat px = 1.0 / self.traitCollection.displayScale;
  UIColor *up = Hex(0xD6293E), *down = Hex(0x1F5FD1), *grid = Hex(0xE3E7EC), *label = Hex(0x7B8692);
  NSDictionary *labelAttrs = @{
    NSFontAttributeName : [UIFont monospacedDigitSystemFontOfSize:10 weight:UIFontWeightRegular],
    NSForegroundColorAttributeName : label
  };

  if (l.candles.empty()) {
    [@"차트 데이터를 불러오는 중…" drawAtPoint:CGPointMake(12, self.bounds.size.height / 2 - 6) withAttributes:labelAttrs];
    return;
  }

  // 격자·가격 눈금
  CGContextSetLineWidth(ctx, px);
  for (const auto &g : l.grid) {
    [grid setStroke];
    CGContextMoveToPoint(ctx, 0, g.y);
    CGContextAddLineToPoint(ctx, l.plotRight, g.y);
    CGContextStrokePath(ctx);
    [FormatPrice(g.price) drawAtPoint:CGPointMake(l.plotRight + 4, g.y - 6) withAttributes:labelAttrs];
  }
  for (const auto &t : l.times) {
    // 첫 눈금이 왼쪽 끝에서 잘리지 않도록
    [FormatTime(t.time) drawAtPoint:CGPointMake(MAX(2.0, t.x - 14), self.bounds.size.height - 14) withAttributes:labelAttrs];
  }

  // 거래량
  for (const auto &c : l.candles) {
    [[(c.up ? up : down) colorWithAlphaComponent:0.25] setFill];
    CGContextFillRect(ctx, CGRectMake(c.x - c.width / 2, c.volumeTop, c.width, c.volumeBottom - c.volumeTop));
  }

  // 캔들: 심지 → 몸통
  for (const auto &c : l.candles) {
    UIColor *color = c.up ? up : down;
    [color setStroke];
    [color setFill];
    CGContextSetLineWidth(ctx, MAX(px, 1.0));
    CGContextMoveToPoint(ctx, c.x, c.wickTop);
    CGContextAddLineToPoint(ctx, c.x, c.wickBottom);
    CGContextStrokePath(ctx);
    CGContextFillRect(ctx, CGRectMake(c.x - c.width / 2, c.bodyTop, c.width, c.bodyBottom - c.bodyTop));
  }

  // 이동평균
  auto polyline = [&](const std::vector<hoga::chart::Point> &points, UIColor *color) {
    if (points.size() < 2) return;
    [color setStroke];
    CGContextSetLineWidth(ctx, 1.2);
    CGContextMoveToPoint(ctx, points[0].x, points[0].y);
    for (size_t i = 1; i < points.size(); i++) CGContextAddLineToPoint(ctx, points[i].x, points[i].y);
    CGContextStrokePath(ctx);
  };
  polyline(l.ma5, Hex(0xC27A00));
  polyline(l.ma20, Hex(0x7B3FBF));

  // 마지막 체결가 선
  if (l.last) {
    UIColor *color = _bars.size() >= 2 && _bars.back().close >= _bars[_bars.size() - 2].close ? up : down;
    [color setStroke];
    const CGFloat dash[] = {3, 3};
    CGContextSetLineDash(ctx, 0, dash, 2);
    CGContextMoveToPoint(ctx, 0, l.last->y);
    CGContextAddLineToPoint(ctx, l.plotRight, l.last->y);
    CGContextStrokePath(ctx);
    CGContextSetLineDash(ctx, 0, NULL, 0);
    CGRect tag = CGRectMake(l.plotRight + 1, l.last->y - 8, self.bounds.size.width - l.plotRight - 1, 16);
    [color setFill];
    CGContextFillRect(ctx, tag);
    [FormatPrice(l.last->price) drawAtPoint:CGPointMake(tag.origin.x + 3, tag.origin.y + 2)
                             withAttributes:@{
                               NSFontAttributeName : [UIFont monospacedDigitSystemFontOfSize:10 weight:UIFontWeightSemibold],
                               NSForegroundColorAttributeName : UIColor.whiteColor
                             }];
  }

  // 십자선
  if (_crosshairX) {
    const auto index = hoga::chart::indexAt(l, static_cast<float>(*_crosshairX));
    if (index) {
      const auto &shape = l.candles[*index - static_cast<size_t>(l.firstIndex)];
      [Hex(0x16202C, 0.6) setStroke];
      CGContextSetLineWidth(ctx, px);
      CGContextMoveToPoint(ctx, shape.x, l.priceTop);
      CGContextAddLineToPoint(ctx, shape.x, l.volumeBottom);
      CGContextStrokePath(ctx);
    }
  }
}

#pragma mark - 제스처

- (CGFloat)spacing
{
  return MAX(1.0, _layout.plotRight / MAX(1, _window.visibleBars));
}

- (void)onPinch:(UIPinchGestureRecognizer *)g
{
  if (g.state == UIGestureRecognizerStateBegan) _gestureStart = _window;
  _window.visibleBars = static_cast<int>(_gestureStart.visibleBars / MAX(0.1, g.scale));
  _window = hoga::chart::clampWindow(_window, _bars.size());
  [self setNeedsDisplay];
}

- (void)onPan:(UIPanGestureRecognizer *)g
{
  if (g.state == UIGestureRecognizerStateBegan) _gestureStart = _window;
  // 오른쪽으로 끌면 과거가 보인다
  _window.offset = _gestureStart.offset + static_cast<int>([g translationInView:self].x / [self spacing]);
  _window = hoga::chart::clampWindow(_window, _bars.size());
  [self setNeedsDisplay];
}

- (void)onLongPress:(UILongPressGestureRecognizer *)g
{
  if (g.state == UIGestureRecognizerStateEnded || g.state == UIGestureRecognizerStateCancelled) {
    _crosshairX.reset();
    [self.delegate chartView:self didMoveCrosshairTo:std::nullopt];
  } else {
    _crosshairX = [g locationInView:self].x;
    const auto index = hoga::chart::indexAt(_layout, static_cast<float>(*_crosshairX));
    if (index && *index < _bars.size()) [self.delegate chartView:self didMoveCrosshairTo:_bars[*index]];
  }
  [self setNeedsDisplay];
}

// 세로 스크롤(부모 ScrollView)은 막지 않도록 가로 움직임일 때만 드래그를 시작한다
- (BOOL)gestureRecognizerShouldBegin:(UIGestureRecognizer *)g
{
  if ([g isKindOfClass:UIPanGestureRecognizer.class]) {
    CGPoint v = [(UIPanGestureRecognizer *)g velocityInView:self];
    return fabs(v.x) > fabs(v.y);
  }
  return YES;
}

@end

#pragma mark - Fabric 컴포넌트

@interface HogaChartComponentView : RCTViewComponentView <HogaChartDrawViewDelegate>
@end

@implementation HogaChartComponentView {
  HogaChartDrawView *_chart;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<HogaChartViewComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const HogaChartViewProps>();
    _props = defaultProps;
    _chart = [[HogaChartDrawView alloc] initWithFrame:self.bounds];
    _chart.delegate = self;
    self.contentView = _chart;
  }
  return self;
}

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps
{
  const auto &p = *std::static_pointer_cast<const HogaChartViewProps>(props);
  [_chart setSymbol:p.symbol intervalMs:p.intervalMs initialBars:p.initialBars];
  _chart.showVolume = p.showVolume;
  _chart.showMA = p.showMA;
  [super updateProps:props oldProps:oldProps];
}

- (void)chartView:(HogaChartDrawView *)view didMoveCrosshairTo:(std::optional<hoga::Candle>)candle
{
  if (!_eventEmitter) return;
  HogaChartViewEventEmitter::OnCrosshair event{};
  event.active = candle.has_value();
  if (candle) {
    event.start = static_cast<double>(candle->start);
    event.open = static_cast<double>(candle->open);
    event.high = static_cast<double>(candle->high);
    event.low = static_cast<double>(candle->low);
    event.close = static_cast<double>(candle->close);
    event.volume = static_cast<double>(candle->volume);
  }
  std::static_pointer_cast<const HogaChartViewEventEmitter>(_eventEmitter)->onCrosshair(event);
}

@end
