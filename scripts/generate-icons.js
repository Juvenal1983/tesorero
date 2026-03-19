#!/usr/bin/env node
/**
 * Genera los íconos PWA para Tesorero.
 * Uso: node scripts/generate-icons.js
 * Requiere: npm install canvas (solo para generación)
 */

const { createCanvas } = require('canvas')
const fs = require('fs')
const path = require('path')

const SIZES = [72, 96, 128, 144, 152, 192, 384, 512]
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons')

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })

SIZES.forEach(size => {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const radius = size * 0.2

  // Fondo redondeado verde
  ctx.beginPath()
  ctx.moveTo(radius, 0)
  ctx.lineTo(size - radius, 0)
  ctx.quadraticCurveTo(size, 0, size, radius)
  ctx.lineTo(size, size - radius)
  ctx.quadraticCurveTo(size, size, size - radius, size)
  ctx.lineTo(radius, size)
  ctx.quadraticCurveTo(0, size, 0, size - radius)
  ctx.lineTo(0, radius)
  ctx.quadraticCurveTo(0, 0, radius, 0)
  ctx.closePath()
  ctx.fillStyle = '#0F6E56'
  ctx.fill()

  // Símbolo $ centrado
  ctx.fillStyle = '#E1F5EE'
  ctx.font = `bold ${size * 0.55}px Arial`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('$', size / 2, size / 2 + size * 0.03)

  const buf = canvas.toBuffer('image/png')
  const outPath = path.join(OUT_DIR, `icon-${size}x${size}.png`)
  fs.writeFileSync(outPath, buf)
  console.log(`✅ ${outPath}`)
})

console.log(`\n🎉 ${SIZES.length} íconos generados en ${OUT_DIR}`)
