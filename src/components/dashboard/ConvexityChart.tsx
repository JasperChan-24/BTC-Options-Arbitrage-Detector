import React, { memo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

interface ConvexityChartProps {
  data: { strike: number; callBid?: number; callAsk?: number; putBid?: number; putAsk?: number }[];
  t: Record<string, string>;
}

const ConvexityChart = memo(({ data, t }: ConvexityChartProps) => (
  <ResponsiveContainer width="100%" height="100%">
    <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
      <XAxis
        dataKey="strike"
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
        formatter={(value: number) => [`$${value.toFixed(2)}`, '']}
        labelFormatter={(label) => `${t.strike}: ${label}`}
      />
      <Legend iconType="circle" wrapperStyle={{ fontSize: '12px' }} />
      <Line type="monotone" dataKey="callAsk" stroke="#ef4444" strokeWidth={2} dot={{ r: 2 }} name={t.callAsk} connectNulls />
      <Line type="monotone" dataKey="callBid" stroke="#22c55e" strokeWidth={2} dot={{ r: 2 }} name={t.callBid} connectNulls />
      <Line type="monotone" dataKey="putAsk" stroke="#f97316" strokeWidth={2} dot={{ r: 2 }} name={t.putAsk} connectNulls />
      <Line type="monotone" dataKey="putBid" stroke="#3b82f6" strokeWidth={2} dot={{ r: 2 }} name={t.putBid} connectNulls />
    </LineChart>
  </ResponsiveContainer>
));
ConvexityChart.displayName = 'ConvexityChart';

export default ConvexityChart;
