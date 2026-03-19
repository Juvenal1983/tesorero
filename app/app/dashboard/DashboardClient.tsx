'use client'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell, LineChart, Line, CartesianGrid,
} from 'recharts'
import { formatCLP, formatCLPCompact, formatPct, colorPorcentaje, MESES_CORTOS, formatFecha } from '@/lib/utils/format'
import type { ResumenFinanciero } from '@/lib/types'

interface Props {
  curso: any
  resumen: ResumenFinanciero
  esLector: boolean
  ingTotalMes: number[]
  gasMes: number[]
  distribucion: { cuotasMen: number; cuotasAnu: number; extras: number }
  ultimos: Array<{ id: string; tipo: string; desc: string; monto: number; fecha: string }>
  totalAlumnos: number
}

const CHART_COLORS = { ing: '#0F6E56', gasto: '#E24B4A', anu: '#378ADD', extra: '#EF9F27' }

export default function DashboardClient({
  curso, resumen, esLector, ingTotalMes, gasMes, distribucion, ultimos, totalAlumnos
}: Props) {
  const barData = MESES_CORTOS.map((mes, i) => ({
    mes, Ingresos: ingTotalMes[i], Gastos: gasMes[i],
  }))

  const donutData = [
    { name: 'Cuotas mensuales', value: distribucion.cuotasMen, color: CHART_COLORS.ing },
    { name: 'Cuota anual', value: distribucion.cuotasAnu, color: CHART_COLORS.anu },
    { name: 'Ingresos extra', value: distribucion.extras, color: CHART_COLORS.extra },
  ].filter(d => d.value > 0)

  const lineData = MESES_CORTOS.map((mes, i) => ({
    mes,
    Saldo: ingTotalMes.slice(0, i + 1).reduce((a, b) => a + b, 0)
         - gasMes.slice(0, i + 1).reduce((a, b) => a + b, 0),
  }))

  const pct = resumen.pct_cumplimiento
  const pctColor = colorPorcentaje(pct)

  return (
    <div className="space-y-5">
      {/* Alerta rol lector */}
      {esLector && (
        <div className="bg-info-light border border-info/20 text-info-600 rounded-lg px-4 py-3 text-sm font-medium flex items-center gap-2">
          👁️ Vista apoderado — información financiera general. Los datos individuales son privados.
        </div>
      )}

      {/* Métricas principales */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="metric-card">
          <div className="metric-label">Total recaudado</div>
          <div className="metric-value text-brand-600">{formatCLP(resumen.total_ingresos)}</div>
          <div className="text-xs text-gray-400 mt-1">Cuotas + extras</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Total gastos</div>
          <div className="metric-value text-danger">{formatCLP(resumen.total_gastos)}</div>
          <div className="text-xs text-gray-400 mt-1">Egresos registrados</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Saldo disponible</div>
          <div className={`metric-value ${resumen.saldo_disponible >= 0 ? 'text-info' : 'text-danger'}`}>
            {formatCLP(resumen.saldo_disponible)}
          </div>
          <div className="text-xs text-gray-400 mt-1">Recaudado – gastos</div>
        </div>
        {!esLector ? (
          <div className="metric-card">
            <div className="metric-label">Cumplimiento</div>
            <div className="metric-value" style={{ color: pctColor }}>{formatPct(pct)}</div>
            <div className="progress-bar mt-2">
              <div className="progress-fill" style={{ width: `${pct}%`, background: pctColor }} />
            </div>
          </div>
        ) : (
          <div className="metric-card">
            <div className="metric-label">Alumnos</div>
            <div className="metric-value text-gray-700">{totalAlumnos}</div>
            <div className="text-xs text-gray-400 mt-1">En el curso</div>
          </div>
        )}
      </div>

      {/* Barra de cumplimiento (solo tesorero) */}
      {!esLector && (
        <div className="card py-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-semibold">Cumplimiento de cuotas mensuales</span>
            <span className="text-sm font-bold" style={{ color: pctColor }}>{formatPct(pct)}</span>
          </div>
          <div className="progress-bar h-3">
            <div className="progress-fill" style={{ width: `${pct}%`, background: pctColor }} />
          </div>
          <div className="text-xs text-gray-400 mt-1.5">
            {resumen.pagos_realizados} de {resumen.pagos_esperados} cuotas mensuales cobradas
          </div>
        </div>
      )}

      {/* Gráficos */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Barras: Ingresos vs Gastos */}
        <div className="card">
          <div className="text-sm font-bold mb-1">Ingresos vs Gastos por mes</div>
          <div className="flex gap-4 mb-3 text-xs text-gray-500">
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm inline-block" style={{background:CHART_COLORS.ing}}/> Ingresos</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm inline-block" style={{background:CHART_COLORS.gasto}}/> Gastos</span>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={barData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <XAxis dataKey="mes" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={formatCLPCompact} axisLine={false} tickLine={false} width={44} />
              <Tooltip formatter={(v: number) => formatCLP(v)} labelStyle={{ fontSize: 12 }} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #eee' }} />
              <Bar dataKey="Ingresos" fill={CHART_COLORS.ing} radius={[3,3,0,0]} />
              <Bar dataKey="Gastos" fill={CHART_COLORS.gasto} radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Dona: Distribución de ingresos */}
        <div className="card">
          <div className="text-sm font-bold mb-1">Distribución de ingresos</div>
          <div className="flex flex-wrap gap-3 mb-3 text-xs text-gray-500">
            {donutData.map(d => (
              <span key={d.name} className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{background:d.color}}/>
                {d.name}
              </span>
            ))}
          </div>
          {donutData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={donutData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} dataKey="value" paddingAngle={3}>
                  {donutData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <Tooltip formatter={(v: number) => formatCLP(v)} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-gray-300 text-sm">Sin datos aún</div>
          )}
        </div>
      </div>

      {/* Evolución del saldo */}
      <div className="card">
        <div className="text-sm font-bold mb-4">Evolución del saldo acumulado</div>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={lineData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="mes" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={formatCLPCompact} axisLine={false} tickLine={false} width={50} />
            <Tooltip formatter={(v: number) => formatCLP(v)} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #eee' }} />
            <Line type="monotone" dataKey="Saldo" stroke={CHART_COLORS.ing} strokeWidth={2.5} dot={{ r: 3, fill: CHART_COLORS.ing }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Últimos movimientos */}
      <div className="card">
        <div className="text-sm font-bold mb-4">Últimos movimientos</div>
        {ultimos.length === 0 ? (
          <div className="empty-state py-8">
            <div className="text-3xl mb-2">💸</div>
            <div>Sin movimientos registrados</div>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {ultimos.map(m => (
              <div key={m.id} className="flex items-center justify-between py-3 gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0
                    ${m.tipo === 'gasto' ? 'bg-danger-light' : 'bg-brand-light'}`}>
                    {m.tipo === 'gasto' ? '↓' : '↑'}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{m.desc}</div>
                    <div className="text-xs text-gray-400">{formatFecha(m.fecha)}</div>
                  </div>
                </div>
                <div className={`text-sm font-bold flex-shrink-0 ${m.tipo === 'gasto' ? 'text-danger' : 'text-brand-600'}`}>
                  {m.tipo === 'gasto' ? '-' : '+'}{formatCLP(m.monto)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Proyección anual (solo tesorero) */}
      {!esLector && (
        <div className="card bg-brand-light border-brand-200">
          <div className="text-sm font-bold text-brand-600 mb-1">Proyección anual</div>
          <div className="text-2xl font-black text-brand-600">{formatCLP(resumen.proyeccion_anual)}</div>
          <div className="text-xs text-brand-400 mt-1">
            Basado en {totalAlumnos} alumnos · cuota mensual {formatCLP(curso.cuota_mensual_clp)} · cuota anual {formatCLP(curso.cuota_anual_clp)}
          </div>
        </div>
      )}
    </div>
  )
}
