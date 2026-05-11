import React, { forwardRef, lazy, Suspense } from 'react';

const ReactECharts = lazy(() => import('echarts-for-react'));

const ChartFallback = ({ style }) => (
  <div style={{ minHeight: style?.height || 240, width: style?.width || '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
    正在加载图表...
  </div>
);

const LazyECharts = forwardRef((props, ref) => (
  <Suspense fallback={<ChartFallback style={props.style} />}>
    <ReactECharts ref={ref} {...props} />
  </Suspense>
));

LazyECharts.displayName = 'LazyECharts';

export default LazyECharts;
