import React, { memo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';

interface PayoffChartProps {
  data: { underlying: number; payoff: number; totalPnL: number }[];
  t: Record<string, string>;
}

const PayoffChart = memo(({ data, t }: PayoffChartProps) => (
  <ResponsiveContainer width="100%" height="100%">
    <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
      <XAxis
        dataKey="underlying"
        type="number"
        domain={['dataMin', 'dataMax']}
        tickFormatter={(val) => `${val / 1000}k`}
        stroke="#94a3b8"
        fontSize={12}
      />
      <YAxis
        stroke="#94a3b8"
        fontSize={12}
        tickFormatter={(val) => `$${val}`}
      />
      <Tooltip
        formatter={(value: number) => [`$${value.toFixed(2)}`, t.totalPnl]}
        labelFormatter={(label) => `${t.btcPrice} $${label}`}
      />
      <ReferenceLine y={0} stroke="#64748b" strokeDasharray="3 3" />
      <Line type="monotone" dataKey="totalPnL" stroke="#6366f1" strokeWidth={2} dot={false} name={t.totalPnlAtMaturity} />
    </LineChart>
  </ResponsiveContainer>
));
PayoffChart.displayName = 'PayoffChart';

export default PayoffChart;
