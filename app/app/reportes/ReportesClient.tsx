'use client'
import { formatCLP, formatFecha, formatPct, colorPorcentaje } from '@/lib/utils/format'
import type { ResumenFinanciero, MovimientoFinanciero } from '@/lib/types'

interface Props {
  curso: any
  resumen: ResumenFinanciero
  movimientos: (MovimientoFinanciero & { categoria?: { nombre: string } })[]
  resumenAlumnos: Array<{ alumno: any; total_pagado: number; pagos_count: number; tiene_anual: boolean }>
  esLector: boolean
}

export default function ReportesClient({ curso, resumen, movimientos, resumenAlumnos, esLector }: Props) {
  const pct = resumen.pct_cumplimiento
  const pctColor = colorPorcentaje(pct)

  async function exportPDF() {
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF()
    const fecha = new Date().toLocaleDateString('es-CL')
    const verde = [15, 110, 86] as [number, number, number]

    doc.setFillColor(...verde)
    doc.rect(0, 0, 210, 30, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(20); doc.setFont('helvetica', 'bold')
    doc.text('TESORERO', 14, 14)
    doc.setFontSize(10); doc.setFont('helvetica', 'normal')
    doc.text(`${esLector ? 'Reporte público' : 'Reporte administrativo'} — ${curso?.nombre || ''}`, 14, 22)

    doc.setTextColor(60, 60, 60)
    doc.setFontSize(9)
    doc.text(`Generado: ${fecha}  ·  Colegio: ${(curso?.colegio as any)?.nombre || ''}  ·  Año: ${curso?.anio_academico}`, 14, 38)

    let y = 48
    const addSection = (title: string) => {
      doc.setFillColor(225, 245, 238)
      doc.rect(14, y, 182, 8, 'F')
      doc.setTextColor(15, 110, 86)
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10)
      doc.text(title.toUpperCase(), 16, y + 5.5)
      doc.setTextColor(60, 60, 60); doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
      y += 12
    }

    addSection('Resumen financiero')
    const rows = [
      ['Total recaudado', formatCLP(resumen.total_ingresos)],
      ['   Cuotas cobradas', formatCLP(resumen.total_cuotas_cobradas)],
      ['   Ingresos extra', formatCLP(resumen.total_ingresos_extra)],
      ['Total gastos', formatCLP(resumen.total_gastos)],
      ['Saldo disponible', formatCLP(resumen.saldo_disponible)],
    ]
    if (!esLector) rows.push(['Cumplimiento cuotas', formatPct(pct)])

    autoTable(doc, {
      startY: y, head: [], body: rows, theme: 'plain',
      styles: { fontSize: 9, cellPadding: 3 },
      columnStyles: { 0: { fontStyle: 'normal', textColor: [80,80,80] }, 1: { fontStyle: 'bold', halign: 'right' } },
      margin: { left: 14, right: 14 },
    })
    y = (doc as any).lastAutoTable.finalY + 10

    if (movimientos.length > 0) {
      addSection('Movimientos')
      autoTable(doc, {
        startY: y,
        head: [['Descripción', 'Tipo', 'Categoría', 'Monto', 'Fecha']],
        body: movimientos.map(m => [
          m.descripcion,
          m.tipo_movimiento === 'ingreso' ? 'Ingreso' : 'Gasto',
          (m.categoria as any)?.nombre || '—',
          (m.tipo_movimiento === 'gasto' ? '-' : '') + formatCLP(m.monto_clp),
          formatFecha(m.fecha_movimiento),
        ]),
        theme: 'striped',
        headStyles: { fillColor: verde, fontSize: 8 },
        styles: { fontSize: 8, cellPadding: 2.5 },
        margin: { left: 14, right: 14 },
      })
      y = (doc as any).lastAutoTable.finalY + 10
    }

    if (!esLector && resumenAlumnos.length > 0) {
      doc.addPage()
      y = 20
      addSection('Estado de pagos por alumno (confidencial — solo tesorero)')
      autoTable(doc, {
        startY: y,
        head: [['Alumno', 'N° pagos', 'Total pagado', 'Cuota anual', 'Estado']],
        body: resumenAlumnos.map(r => [
          `${r.alumno.apellidos}, ${r.alumno.nombres}`,
          String(r.pagos_count),
          formatCLP(r.total_pagado),
          r.tiene_anual ? 'Pagada' : 'Pendiente',
          r.total_pagado > 0 ? 'Al día' : 'Pendiente',
        ]),
        theme: 'striped',
        headStyles: { fillColor: verde, fontSize: 8 },
        styles: { fontSize: 8, cellPadding: 2.5 },
        margin: { left: 14, right: 14 },
      })
    }

    // Footer
    const pageCount = (doc as any).internal.getNumberOfPages()
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i)
      doc.setFontSize(7); doc.setTextColor(150, 150, 150)
      doc.text(`Tesorero · ${curso?.nombre} · ${fecha} · Página ${i} de ${pageCount}`, 14, 290)
      if (esLector) doc.text('Este reporte no contiene información individual de apoderados ni alumnos.', 14, 294)
    }

    const filename = `Reporte_${(curso?.nombre || 'curso').replace(/\s/g, '_')}_${new Date().getFullYear()}.pdf`
    doc.save(filename)
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()

    // Hoja resumen
    const resumenData = [
      ['TESORERO — Reporte financiero'],
      [`Curso: ${curso?.nombre}  |  Año: ${curso?.anio_academico}  |  Colegio: ${(curso?.colegio as any)?.nombre}`],
      [`Generado: ${new Date().toLocaleDateString('es-CL')}`],
      [],
      ['Concepto', 'Monto CLP'],
      ['Total recaudado', resumen.total_ingresos],
      ['Cuotas cobradas', resumen.total_cuotas_cobradas],
      ['Ingresos extra', resumen.total_ingresos_extra],
      ['Total gastos', resumen.total_gastos],
      ['Saldo disponible', resumen.saldo_disponible],
      ...(!esLector ? [['Cumplimiento', `${formatPct(pct)}`]] : []),
    ]
    const wsResumen = XLSX.utils.aoa_to_sheet(resumenData)
    XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen')

    // Hoja movimientos
    const movData = [
      ['Descripción', 'Tipo', 'Categoría', 'Monto', 'Fecha', 'Responsable', 'Visible'],
      ...movimientos.map(m => [
        m.descripcion,
        m.tipo_movimiento,
        (m.categoria as any)?.nombre || '',
        m.tipo_movimiento === 'gasto' ? -m.monto_clp : m.monto_clp,
        formatFecha(m.fecha_movimiento),
        m.responsable || '',
        m.visible_para_apoderados ? 'Sí' : 'No',
      ]),
    ]
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(movData), 'Movimientos')

    if (!esLector && resumenAlumnos.length > 0) {
      const aluData = [
        ['Alumno', 'Apellidos', 'Nro. Pagos', 'Total Pagado CLP', 'Cuota Anual', 'Estado'],
        ...resumenAlumnos.map(r => [
          r.alumno.nombres, r.alumno.apellidos,
          r.pagos_count, r.total_pagado,
          r.tiene_anual ? 'Pagada' : 'Pendiente',
          r.total_pagado > 0 ? 'Al día' : 'Pendiente',
        ]),
      ]
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aluData), 'Alumnos (confidencial)')
    }

    const filename = `Reporte_${(curso?.nombre || 'curso').replace(/\s/g, '_')}_${new Date().getFullYear()}.xlsx`
    XLSX.writeFile(wb, filename)
  }

  return (
    <div className="space-y-5 max-w-3xl">
      {/* Banner lector */}
      {esLector && (
        <div className="bg-info-light border border-info/20 text-info-600 rounded-lg px-4 py-3 text-sm font-medium">
          👁️ Reporte público — no contiene información individual de alumnos ni apoderados.
        </div>
      )}

      {/* Header con botones */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-lg font-black">{curso?.nombre} · {curso?.anio_academico}</div>
          <div className="text-sm text-gray-400">{(curso?.colegio as any)?.nombre}</div>
        </div>
        <div className="flex gap-2">
          <button className="btn no-print" onClick={exportPDF}>📄 Exportar PDF</button>
          {!esLector && <button className="btn no-print" onClick={exportExcel}>📊 Exportar Excel</button>}
        </div>
      </div>

      {/* Resumen financiero */}
      <div className="card">
        <div className="text-sm font-bold mb-4">Resumen financiero</div>
        <div className="space-y-0">
          <div className="info-row flex justify-between py-2.5 border-b border-gray-50 text-sm">
            <span className="text-gray-500">Total recaudado</span>
            <span className="font-bold text-brand-600">{formatCLP(resumen.total_ingresos)}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-gray-50 text-sm pl-4">
            <span className="text-gray-400">Cuotas cobradas</span>
            <span className="font-semibold">{formatCLP(resumen.total_cuotas_cobradas)}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-gray-50 text-sm pl-4">
            <span className="text-gray-400">Ingresos extra</span>
            <span className="font-semibold">{formatCLP(resumen.total_ingresos_extra)}</span>
          </div>
          <div className="flex justify-between py-2.5 border-b border-gray-50 text-sm">
            <span className="text-gray-500">Total gastos</span>
            <span className="font-bold text-danger">{formatCLP(resumen.total_gastos)}</span>
          </div>
          <div className="flex justify-between py-3 text-base">
            <span className="font-bold">Saldo disponible</span>
            <span className={`font-black text-lg ${resumen.saldo_disponible >= 0 ? 'text-brand-600' : 'text-danger'}`}>
              {formatCLP(resumen.saldo_disponible)}
            </span>
          </div>
        </div>
        {!esLector && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="flex justify-between text-sm mb-1.5">
              <span className="text-gray-500">Cumplimiento cuotas mensuales</span>
              <span className="font-bold" style={{ color: pctColor }}>{formatPct(pct)}</span>
            </div>
            <div className="progress-bar h-2.5">
              <div className="progress-fill" style={{ width: `${pct}%`, background: pctColor }} />
            </div>
            <div className="text-xs text-gray-400 mt-1">
              {resumen.pagos_realizados} de {resumen.pagos_esperados} cuotas mensuales cobradas · {resumen.total_alumnos} alumnos activos
            </div>
          </div>
        )}
      </div>

      {/* Detalle por alumno — solo tesorero */}
      {!esLector && resumenAlumnos.length > 0 && (
        <div className="card p-0 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <div className="text-sm font-bold">Estado de pagos por alumno</div>
            <div className="text-xs text-danger font-medium mt-0.5">
              🔒 Información confidencial — solo visible para el tesorero
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Alumno</th>
                  <th>Pagos registrados</th>
                  <th>Total pagado</th>
                  <th>Cuota anual</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {resumenAlumnos.map(r => (
                  <tr key={r.alumno.id}>
                    <td className="font-semibold">{r.alumno.apellidos}, {r.alumno.nombres}</td>
                    <td><span className="badge badge-blue">{r.pagos_count} pagos</span></td>
                    <td className="font-bold text-brand-600">{formatCLP(r.total_pagado)}</td>
                    <td>
                      <span className={`badge ${r.tiene_anual ? 'badge-green' : 'badge-gray'}`}>
                        {r.tiene_anual ? 'Pagada' : 'Pendiente'}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${r.total_pagado > 0 ? 'badge-green' : 'badge-red'}`}>
                        {r.total_pagado > 0 ? 'Al día' : 'Pendiente'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
