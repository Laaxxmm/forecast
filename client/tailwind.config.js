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
      },
      boxShadow: {
        'glow': '0 0 20px rgba(16, 185, 129, 0.15)',
        'glow-lg': '0 0 40px rgba(16, 185, 129, 0.2)',
        'card': '0 1px 3px rgba(0, 0, 0, 0.3), 0 1px 2px rgba(0, 0, 0, 0.2)',
        'card-hover': '0 4px 12px rgba(0, 0, 0, 0.4)',
        'card-light': '0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.06)',
        'card-light-hover': '0 4px 12px rgba(0, 0, 0, 0.1)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
      },
    },
  },
  plugins: [],
};
