# 💰 Tesorero — PWA de Administración Financiera

Plataforma para administrar cuotas, pagos, ingresos y gastos de cursos escolares en Chile.

## Stack

| Capa | Tecnología |
|------|------------|
| Frontend | Next.js 14 · React · TypeScript |
| UI | Tailwind CSS |
| Backend/Auth | Supabase (PostgreSQL + Auth + Storage) |
| Gráficos | Recharts |
| PDF | jsPDF + jspdf-autotable |
| Excel | SheetJS (xlsx) |
| PWA | next-pwa + Workbox |
| Despliegue | Vercel |

---

## Setup rápido

### 1. Clonar e instalar

```bash
git clone https://github.com/tu-usuario/tesorero.git
cd tesorero
npm install
```

### 2. Configurar Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com)
2. Ve a **SQL Editor** y ejecuta el archivo:
   ```
   supabase/migrations/001_initial_schema.sql
   ```
3. Ve a **Storage** y crea el bucket `comprobantes` (privado)
4. Configura las políticas de Storage para el bucket

### 3. Variables de entorno

```bash
cp .env.local.example .env.local
```

Edita `.env.local` con tus credenciales de Supabase:

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

### 4. Crear usuario inicial

En **Supabase Dashboard → Authentication → Users**, crea un usuario con email/password.

Luego en SQL Editor ejecuta:

```sql
UPDATE usuarios 
SET rol = 'superadmin'
WHERE email = 'tu@email.cl';
```

### 5. Correr en desarrollo

```bash
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000)

---

## Despliegue en Vercel

```bash
npm install -g vercel
vercel
```

Agrega las variables de entorno en el dashboard de Vercel.

---

## Estructura del proyecto

```
tesorero/
├── app/
│   ├── auth/login/          # Login + acceso por código
│   ├── app/
│   │   ├── dashboard/       # Dashboard con gráficos
│   │   ├── alumnos/         # CRUD alumnos y apoderados
│   │   ├── cuotas/          # Configuración de cuotas
│   │   ├── pagos/           # Registro de pagos por alumno
│   │   ├── movimientos/     # Ingresos y gastos extra
│   │   ├── reportes/        # PDF + Excel
│   │   └── config/          # Configuración del curso
│   └── api/export/          # API routes para exportación
├── components/
│   ├── layout/              # Sidebar, Topbar, BottomNav
│   └── ui/                  # Modal, componentes reutilizables
├── lib/
│   ├── actions/             # Server Actions (alumnos, pagos, movimientos, cursos)
│   ├── supabase/            # Clients (browser, server, admin)
│   ├── types/               # TypeScript types
│   └── utils/               # Formateo CLP, fechas, cálculos
├── public/
│   ├── manifest.json        # PWA manifest
│   └── icons/               # Íconos para instalación
└── supabase/
    └── migrations/          # SQL completo con RLS
```

---

## Roles

| Rol | Descripción |
|-----|-------------|
| `superadmin` | Acceso total a todos los colegios y cursos |
| `tesorero` | Administra su(s) curso(s): CRUD completo, reportes, deuda individual |
| `apoderado_lector` | Acceso por código único: solo lectura de datos públicos |

### Regla de privacidad (no negociable)

> Los balances generales son visibles para todos. **Jamás** se expone qué alumno/apoderado pagó, tiene deuda o mora. Solo el tesorero puede acceder a esa información.

---

## Instalar como PWA

- **Android (Chrome)**: aparece automáticamente el prompt "Agregar a pantalla de inicio"
- **iPhone (Safari)**: Compartir → "Añadir a pantalla de inicio"
- **Desktop (Chrome/Edge)**: ícono de instalación en la barra de dirección

---

## Licencia

MIT — Uso libre para proyectos educativos.
