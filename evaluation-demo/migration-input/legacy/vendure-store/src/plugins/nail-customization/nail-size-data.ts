/**
 * 甲片尺寸对照表 (Nail Tip Size Chart)
 * 
 * 数据来源：指甲尺寸列表（de）.xlsx — 已校对完毕
 * 
 * 说明：
 * - arcLength: 弧长（mm），甲片横截面的弧线长度
 * - chordLength: 弦长（mm），可选，弧的直线距离。弦长越短表示甲片越弯
 * - number: 甲片型号，出厂印在甲片上的编号
 * 
 * 4 种甲型：
 * - short-stiletto (kurz Spitze Form): 短尖形
 * - short-oval (kurz Oval): 短椭圆
 * - short-coffin (kurz Sargform/Ballerinaform): 短棺材/芭蕾形
 * - short-squoval (kurz Squoval): 短方椭圆
 */

export interface NailSizeEntry {
    /** 序号 (1-15) */
    index: number;
    /** 甲片型号 (出厂编号) */
    number: string;
    /** 弧长 (mm) */
    arcLength: number;
    /** 弦长 (mm)，可选 */
    chordLength?: number;
}

export interface NailShapeData {
    /** 甲型代码 */
    code: string;
    /** 甲型中文名 */
    nameZh: string;
    /** 甲型德文名 */
    nameDe: string;
    /** 15 个尺寸 */
    sizes: NailSizeEntry[];
}

/**
 * 4 种甲型的尺寸数据（已用 Excel 真实数据校对）
 * 
 * 甲型说明：
 * - short-stiletto (短尖形): 尖锐的甲片形状
 * - short-oval (短椭圆): 椭圆形甲片
 * - short-coffin (短棺材/芭蕾): 棺材形/芭蕾形甲片
 * - short-squoval (短方椭圆): 方形与椭圆形的混合
 */
export const NAIL_SHAPES: NailShapeData[] = [
    {
        code: 'short-stiletto',
        nameZh: '短尖形',
        nameDe: 'Kurz Spitze Form',
        sizes: [
            { index: 1, number: '0', arcLength: 18 },
            { index: 2, number: '1', arcLength: 16 },
            { index: 3, number: '2', arcLength: 15 },
            { index: 4, number: '3', arcLength: 14 },
            { index: 5, number: '4', arcLength: 13.5 },
            { index: 6, number: '5', arcLength: 13 },
            { index: 7, number: '6', arcLength: 12.5, chordLength: 9.8 },
            { index: 8, number: '7', arcLength: 12.5, chordLength: 9.3 },
            { index: 9, number: '8', arcLength: 11 },
            { index: 10, number: '8.5', arcLength: 10.5 },
            { index: 11, number: '9', arcLength: 10 },
            { index: 12, number: '9.5', arcLength: 9 },
            { index: 13, number: '10', arcLength: 9 },
            { index: 14, number: '10.5', arcLength: 8 },
            { index: 15, number: '11', arcLength: 7.5 },
        ],
    },
    {
        code: 'short-oval',
        nameZh: '短椭圆',
        nameDe: 'Kurz Oval',
        sizes: [
            { index: 1, number: '0', arcLength: 17.5 },
            { index: 2, number: '1', arcLength: 17 },
            { index: 3, number: '2', arcLength: 16.5 },
            { index: 4, number: '3', arcLength: 15 },
            { index: 5, number: '4', arcLength: 14.2, chordLength: 11.2 },
            { index: 6, number: '5', arcLength: 14, chordLength: 10.6 },
            { index: 7, number: '6', arcLength: 13.3 },
            { index: 8, number: '7', arcLength: 13 },
            { index: 9, number: '8', arcLength: 12.5 },
            { index: 10, number: '8.5', arcLength: 11.5, chordLength: 8.9 },
            { index: 11, number: '9', arcLength: 11.5, chordLength: 8.5 },
            { index: 12, number: '9.5', arcLength: 11 },
            { index: 13, number: '10', arcLength: 10 },
            { index: 14, number: '10.5', arcLength: 9.5 },
            { index: 15, number: '11', arcLength: 8.5 },
        ],
    },
    {
        code: 'short-coffin',
        nameZh: '短棺材/芭蕾',
        nameDe: 'Kurz Sargform/Ballerinaform',
        sizes: [
            { index: 1, number: '0', arcLength: 18.5 },
            { index: 2, number: '1', arcLength: 17 },
            { index: 3, number: '2', arcLength: 15.7, chordLength: 11.5 },
            { index: 4, number: '3', arcLength: 15, chordLength: 11.2 },
            { index: 5, number: '4', arcLength: 14 },
            { index: 6, number: '5', arcLength: 13.5 },
            { index: 7, number: '6', arcLength: 13 },
            { index: 8, number: '7', arcLength: 12.5, chordLength: 9.3 },
            { index: 9, number: '8', arcLength: 12.2, chordLength: 8.8 },
            { index: 10, number: '8.5', arcLength: 11.8 },
            { index: 11, number: '9', arcLength: 11 },
            { index: 12, number: '9.5', arcLength: 10.2 },
            { index: 13, number: '10', arcLength: 9.5 },
            { index: 14, number: '10.5', arcLength: 9 },
            { index: 15, number: '11', arcLength: 8.5 },
        ],
    },
    {
        code: 'short-squoval',
        nameZh: '短方椭圆',
        nameDe: 'Kurz Squoval',
        sizes: [
            { index: 1, number: '0', arcLength: 17 },
            { index: 2, number: '1', arcLength: 16 },
            { index: 3, number: '2', arcLength: 15 },
            { index: 4, number: '3', arcLength: 14.5 },
            { index: 5, number: '4', arcLength: 13.8 },
            { index: 6, number: '5', arcLength: 13 },
            { index: 7, number: '6', arcLength: 12, chordLength: 9.3 },
            { index: 8, number: '7', arcLength: 11.7, chordLength: 9 },
            { index: 9, number: '8', arcLength: 11.3, chordLength: 8.6 },
            { index: 10, number: '8.5', arcLength: 11, chordLength: 8.3 },
            { index: 11, number: '9', arcLength: 10.5, chordLength: 8.3 },
            { index: 12, number: '9.5', arcLength: 10.2, chordLength: 7.9 },
            { index: 13, number: '10', arcLength: 9.5, chordLength: 7.7 },
            { index: 14, number: '10.5', arcLength: 9.5, chordLength: 7.5 },
            { index: 15, number: '11', arcLength: 9, chordLength: 7.2 },
        ],
    },
];

/** 手指代码常量 */
export const FINGER_CODES = [
    'leftThumb', 'leftIndex', 'leftMiddle', 'leftRing', 'leftPinky',
    'rightThumb', 'rightIndex', 'rightMiddle', 'rightRing', 'rightPinky',
] as const;

export type FingerCode = typeof FINGER_CODES[number];

/** 手指显示名（中文） */
export const FINGER_NAMES_ZH: Record<FingerCode, string> = {
    leftThumb: '左手拇指',
    leftIndex: '左手食指',
    leftMiddle: '左手中指',
    leftRing: '左手无名指',
    leftPinky: '左手小指',
    rightThumb: '右手拇指',
    rightIndex: '右手食指',
    rightMiddle: '右手中指',
    rightRing: '右手无名指',
    rightPinky: '右手小指',
};

/** 手指显示名（德文） */
export const FINGER_NAMES_DE: Record<FingerCode, string> = {
    leftThumb: 'L. Daumen',
    leftIndex: 'L. Zeigefinger',
    leftMiddle: 'L. Mittelfinger',
    leftRing: 'L. Ringfinger',
    leftPinky: 'L. kl. Finger',
    rightThumb: 'R. Daumen',
    rightIndex: 'R. Zeigefinger',
    rightMiddle: 'R. Mittelfinger',
    rightRing: 'R. Ringfinger',
    rightPinky: 'R. kl. Finger',
};

/**
 * 尺寸匹配算法
 * 
 * 根据客户的弧长和选择的甲型，匹配对应的甲片型号。
 * 
 * 注意：尺寸表是从大到小排列的（型号 0 最大，型号 11 最小）。
 * 规则：找到弧长 ≤ 客户弧长的最大型号（即甲片不会比手指宽）。
 * 如果弧长落在两个型号之间，取更小的甲片（更紧贴）。
 * 
 * @param arcLength 客户测量的弧长 (mm)
 * @param shapeCode 甲型代码 (如 'short-oval')
 * @returns 匹配结果，包含甲片型号和弧长
 */
export function matchNailSize(
    arcLength: number,
    shapeCode: string,
): { number: string; arcLength: number; chordLength?: number; exact: boolean } | null {
    const shape = NAIL_SHAPES.find(s => s.code === shapeCode);
    if (!shape) return null;

    const sizes = shape.sizes;

    // 尺寸表从大到小排列（index 1 = 最大, index 15 = 最小）
    // 找到弧长 ≤ 输入值的第一个型号（从大到小遍历）

    // 如果比最大的还大，返回最大型号
    if (arcLength >= sizes[0].arcLength) {
        return {
            number: sizes[0].number,
            arcLength: sizes[0].arcLength,
            chordLength: sizes[0].chordLength,
            exact: arcLength === sizes[0].arcLength,
        };
    }

    // 如果比最小的还小，返回最小型号
    if (arcLength <= sizes[sizes.length - 1].arcLength) {
        return {
            number: sizes[sizes.length - 1].number,
            arcLength: sizes[sizes.length - 1].arcLength,
            chordLength: sizes[sizes.length - 1].chordLength,
            exact: arcLength === sizes[sizes.length - 1].arcLength,
        };
    }

    // 规则：找到弧长 <= 客户弧长 且 物理尺寸最小（型号数字最大）的甲片。
    // 由于 sizes 是降序排列的（18, 16, 15...），我们从头开始找，
    // 第一个满足 sizes[i].arcLength <= arcLength 的就是我们要的。
    // 这样既满足了“取更小的甲片”，也解决了“17.5 -> 16”的问题。
    // 同时，如果 12.5mm 对应两个型号，第一个碰到的（i 较小）物理尺寸更大，
    // 我们需要确保选择的是物理尺寸更小的那个。
    // 修正：从后往前找，第一个满足 sizes[i].arcLength >= arcLength 的又是偏大的。

    // 正确逻辑：从前往后找，找到第一个 sizes[i].arcLength <= arcLength 的型号。
    // 例如 short-stiletto: 0:18, 1:16, 2:15...
    // 输入 17.5: 
    // i=0 (18): 18 <= 17.5 (False)
    // i=1 (16): 16 <= 17.5 (True) -> 返回型号 1。完美。
    // 输入 12.5:
    // i=6 (12.5): 12.5 <= 12.5 (True) -> 返回型号 6。
    // 等等，如果 12.5 对应 6 和 7，我们要 7。
    // 所以应该找最后一个满足 sizes[i].arcLength >= arcLength 的型号？不，那是取大的。

    // 最终逻辑：从前往后遍历，找到第一个 arcLength <= 输入值的，
    // 但如果接下来的型号 arcLength 依然相等，就继续往后拿。
    let match: any = null;
    for (let i = 0; i < sizes.length; i++) {
        if (sizes[i].arcLength <= arcLength) {
            match = sizes[i];
            // 如果下一个型号的弧长还是一样，我们倾向于取下一个（通常型号数字更大，实物更小）
            if (i + 1 < sizes.length && sizes[i + 1].arcLength === sizes[i].arcLength) {
                continue;
            }
            break;
        }
    }

    /** 手指序号对应关系 */
    // 0:18, 1:16, 2:15, 3:14, 4:13.5, 5:13, 6:12.5, 7:12.5, 8:11, ...

    // 逻辑：我们要找到一个甲片，其 arcLength <= 客户测量的 arcLength。
    // 且在所有满足条件的甲片中，我们要挑“最贴合”也就是“物理尺寸最大的那个”？
    // 不，用户说：“17.5 落在 18 和 16 之间，取小的，就是 16”。
    // 这意味着：在所有满足 arcLength <= 输入值的甲片中，我们要选最大的那个 arcLength。
    // 如果有多个相同 arcLength 的，选型号编号更大的（物理更小更紧贴）。

    let selectedMatch: NailSizeEntry | null = null;

    for (const sizeEntry of sizes) {
        if (sizeEntry.arcLength <= arcLength) {
            // 找到了第一个满足条件的（因为是降序，所以这是最大的 arcLength <= input）
            selectedMatch = sizeEntry;

            // 继续往后看，有没有 arcLength 相同但型号更大的？
            // 比如 12.5mm 有 6 号和 7 号。我们碰到了 6，要继续看有没有 7。
            const currentIndex = sizes.indexOf(sizeEntry);
            for (let j = currentIndex + 1; j < sizes.length; j++) {
                if (sizes[j].arcLength === selectedMatch.arcLength) {
                    selectedMatch = sizes[j];
                } else {
                    break;
                }
            }
            break;
        }
    }

    if (selectedMatch) {
        return {
            number: selectedMatch.number,
            arcLength: selectedMatch.arcLength,
            chordLength: selectedMatch.chordLength,
            exact: selectedMatch.arcLength === arcLength,
        };
    }

    return null;
}
