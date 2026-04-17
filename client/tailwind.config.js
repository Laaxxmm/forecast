/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Semantic background/border colors — auto-switch via CSS variables
        dark: {
          950: 'rgb(var(--c-dark-950) / <alpha-value>)',
          900: 'rgb(var(--c-dark-900) / <alpha-value>)',
          800: 'rgb(var(--c-dark-800) / <alpha-value>)',
          700: 'rgb(var(--c-dark-700) / <alpha-value>)',
          600: 'rgb(var(--c-dark-600) / <alpha-value>)',
          500: 'rgb(var(--c-dark-500) / <alpha-value>)',
          400: 'rgb(var(--c-dark-400) / <alpha-value>)',
          300: 'rgb(var(--c-dark-300) / <alpha-value>)',
        },
        // Semantic text colors — auto-switch via CSS variables
        theme: {
          heading: 'rgb(var(--c-text-heading) / <alpha-value>)',
          primary: 'rgb(var(--c-text-primary) / <alpha-value>)',
          secondary: 'rgb(var(--c-text-secondary) / <alpha-value>)',
          muted: 'rgb(var(--c-text-muted) / <alpha-value>)',
          faint: 'rgb(var(--c-text-faint) / <alpha-value>)',
        },
        // Emerald accent (primary)
        accent: {
          50: '#ecfdf5',
          100: '#d1fae5',
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
          800: '#065f46',
          900: '#064e3b',
        },
        // Keep primary as alias for accent
        primary: {
          50: '#ecfdf5',
          100: '#d1fae5',
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
          800: '#065f46',
          900: '#064e3b',
        },
      },
      borderRadius: {
        'xl': '12px',
        '2xl': '16px',
        '3xl': '20px',
        '4xl': '24px',
      },
      boxShadow: {
        // Brand glow
        'glow': '0 0 20px rgba(16, 185, 129, 0.18)',
        'glow-lg': '0 0 40px rgba(16, 185, 129, 0.22)',
        'glow-soft': '0 8px 32px -8px rgba(16, 185, 129, 0.35)',
        // Legacy card shadows (kept for compat)
        'card': '0 1px 3px rgba(0, 0, 0, 0.3), 0 1px 2px rgba(0, 0, 0, 0.2)',
        'card-hover': '0 4px 12px rgba(0, 0, 0, 0.4)',
        'card-light': '0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.06)',
        'card-light-hover': '0 4px 12px rgba(0, 0, 0, 0.1)',
        // New elevation system — layered shadows for proper depth
        'elev-1': '0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 3px 0 rgb(0 0 0 / 0.06)',
        'elev-2': '0 2px 4px -1px rgb(0 0 0 / 0.05), 0 4px 6px -2px rgb(0 0 0 / 0.04)',
        'elev-3': '0 4px 8px -2px rgb(0 0 0 / 0.06), 0 12px 24px -4px rgb(0 0 0 / 0.08)',
        'elev-4': '0 8px 16px -4px rgb(0 0 0 / 0.08), 0 20px 40px -8px rgb(0 0 0 / 0.12)',
        // Inner highlight for glass surfaces
        'inner-highlight': 'inset 0 1px 0 0 rgb(255 255 255 / 0.06)',
        'inner-highlight-light': 'inset 0 1px 0 0 rgb(255 255 255 / 0.8)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-conic': 'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
        'shimmer': 'linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)',
        'accent-gradient': 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
        'accent-gradient-soft': 'linear-gradient(135deg, rgba(16,185,129,0.12) 0%, rgba(5,150,105,0.04) 100%)',
      },
      backdropBlur: {
        xs: '2px',
      },
      transitionTimingFunction: {
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        'smooth': 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      keyframes: {
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'float': {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-4px)' },
        },
      },
      animation: {
        'shimmer': 'shimmer 2s linear infinite',
        'float': 'float 4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
