/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,css}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        cream: '#FFF9F7',
        sakura: '#F8E8EC',
        rose: '#DDA3B0',
        rosedeep: '#A96879',
        ink: '#51454A',
        muted: '#9A858C',
        // 深色模式
        night: '#221E26',
        nightcard: '#2C2731',
        nightline: '#3D3642',
        nightmuted: '#A99AA6'
      },
      fontFamily: {
        serif: ['"Noto Serif SC"', 'Songti SC', 'SimSun', 'Georgia', 'serif'],
        sans: ['"Noto Sans SC"', 'PingFang SC', 'Microsoft YaHei', 'system-ui', 'sans-serif']
      },
      boxShadow: {
        soft: '0 6px 24px -8px rgba(169, 104, 121, 0.18)',
        lift: '0 14px 32px -12px rgba(169, 104, 121, 0.28)'
      },
      borderRadius: {
        xl2: '1.25rem'
      }
    }
  },
  plugins: []
};
