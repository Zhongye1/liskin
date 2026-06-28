import type { Config } from 'tailwindcss';

/**
 * Liskin Web 设计令牌（design tokens）。
 *
 * 这一层是 UI harness 的地基：颜色 / 字体 / 圆角 / 阴影 集中定义，
 * 所有展示型组件只消费语义化 token（canvas / panel / accent…），
 * 不写死十六进制色值，方便后续整体换肤。
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 画布与面板
        canvas: '#1f1e1c', // 顶部浏览器外壳
        sidebar: '#f6f2ec', // 左侧栏暖米色
        panel: '#faf9f7', // 右侧对话区
        card: '#ffffff',
        // 品牌强调色（Claude 风格陶土橙）
        accent: {
          DEFAULT: '#cc7a5b',
          soft: '#f3e3da',
          ink: '#9c4f33',
        },
        // 中性色阶
        ink: {
          DEFAULT: '#2b2722',
          soft: '#6f675e',
          faint: '#a39a8e',
        },
        line: '#e7e0d6',
        // 工具步骤状态
        ok: '#3f8f6b',
        warn: '#c08a2d',
        danger: '#c5533f',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        xl2: '1rem',
      },
      boxShadow: {
        panel: '0 1px 2px rgba(43, 39, 34, 0.04), 0 8px 24px rgba(43, 39, 34, 0.06)',
        composer: '0 1px 0 rgba(43, 39, 34, 0.04), 0 6px 16px rgba(43, 39, 34, 0.08)',
      },
    },
  },
  plugins: [],
} satisfies Config;
