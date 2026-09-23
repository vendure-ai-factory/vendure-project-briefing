import { CurrencyCode, LanguageCode } from '@vendure/core';

/**
 * 按国家获取货币代码
 * DE / AT → EUR | HU → HUF
 */
export function getCurrencyCode(country: string): CurrencyCode {
    switch (country.toUpperCase()) {
        case 'HU': return CurrencyCode.HUF;
        default: return CurrencyCode.EUR;
    }
}

/**
 * 按国家获取价格（单位：分 / 最小货币单位）
 * EUR: 1500 = 15.00€ | HUF: 5500 = 5500 Ft（HUF无小数）
 */
export function getPrice(country: string): number {
    switch (country.toUpperCase()) {
        case 'HU': return 5500;   // 5500 Ft
        default: return 1500;   // 15.00 EUR
    }
}

export const productTemplate = {
    name: (id: string) => `Nail Design ${id}`,
    slug: (id: string) => `nail-design-${id}`,
    description: `
        <p>High-quality custom nail design. Hand-crafted and made to order.</p>
        <p>Includes:</p>
        <ul>
            <li>10x Custom Nails</li>
            <li>Application Kit</li>
            <li>Instructions</li>
        </ul>
    `,
    translations: [
        { languageCode: LanguageCode.zh, name: (id: string) => `美甲设计 ${id}`, description: '高品质手工穿戴甲...' },
        { languageCode: LanguageCode.en, name: (id: string) => `Nail Design ${id}`, description: 'High-quality custom nail design...' },
    ]
};
