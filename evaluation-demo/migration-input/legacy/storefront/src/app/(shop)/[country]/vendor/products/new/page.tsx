'use client';

import Link from 'next/link';
import { useSearchParams, useParams } from 'next/navigation';
import { useState, useRef, useCallback, useEffect } from 'react';
import { publishDesign, getDesignById, getAllCommissionInfo } from '@/lib/vendure/vendor';
import { getAuthTokenClient } from '@/lib/auth-client';

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

interface DesignPair {
    id: string;
    designImage: File | null;
    effectImage: File | null;
    designPreview: string;
    effectPreview: string;
}

interface CountryPricing {
    code: string;
    channelToken: string;
    name: string;
    flag: string;
    currency: string;
    enabled: boolean;
    designFee: number;
    craftFee: number;
    stockLevel: number; // 新增：库存上限
}

const SUPPORTED_COUNTRIES = [
    { code: 'DE', channelToken: 'germany-channel', name: '德国', flag: '🇩🇪', currency: 'EUR' },
    { code: 'AT', channelToken: 'austria-channel', name: '奥地利', flag: '🇦🇹', currency: 'EUR' },
    { code: 'HU', channelToken: 'hungary-channel', name: '匈牙利', flag: '🇭🇺', currency: 'HUF' },
];

// ─── 分成逻辑预览 ───
// 此处现改为从 API 动态获取的分成数据进行计算
const calculateEarnings = (commissions: any[], channelToken: string, fee: number) => {
    const countryConfig = commissions.find(c => c.channelToken === channelToken);
    if (!countryConfig || !countryConfig.tiers || countryConfig.tiers.length === 0) {
        return fee; // 默认不分成
    }

    const tiers = countryConfig.tiers;
    // 寻找匹配的阶梯
    const tier = tiers.find((t: any) => fee >= t.from && fee < t.to);
    
    if (tier) {
        return fee * tier.designerRate;
    }
    
    // 如果超过最高阶梯，取最后一个
    const lastTier = tiers[tiers.length - 1];
    return fee * lastTier.designerRate;
};

// ─── 发布新设计页面 ───────────────────────────────────────────────────────────

export default function NewProductPage() {
    // ── 表单状态 ──
    const [name, setName] = useState('');
    const [craftFees, setCraftFees] = useState<any[]>([]);
    const [countrySettings, setCountrySettings] = useState<CountryPricing[]>(
        SUPPORTED_COUNTRIES.map(c => ({ ...c, enabled: c.code === 'DE', designFee: 0, craftFee: 0, stockLevel: -1 }))
    );
    const [mainEffectImage, setMainEffectImage] = useState<File | null>(null);
    const [mainEffectPreview, setMainEffectPreview] = useState('');
    const [pairs, setPairs] = useState<DesignPair[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
    const [commissions, setCommissions] = useState<any[]>([]);
    const [loadingTemplate, setLoadingTemplate] = useState(false);

    // ── 获取分成配置 ──
    useEffect(() => {
        // 1. 加载分成配置
        getAllCommissionInfo().then(data => {
            if (data && data.length > 0) {
                setCommissions(data);
                console.log('🔄 已加载动态分成配置:', data);
            }
        }).catch(err => {
            console.error('❌ 加载分成配置失败:', err);
        });

        // 2. 加载制作费配置
        import('@/lib/vendure/vendor').then(m => m.getAllCraftFeeInfo()).then(data => {
            if (data && data.length > 0) {
                setCraftFees(data);
                console.log('🔄 已加载动态制作费配置:', data);
                
                // 更新初始化的 countrySettings 中的 craftFee
                setCountrySettings(prev => prev.map(c => {
                    const feeEntry = data.find(f => f.channelToken === c.channelToken);
                    return { ...c, craftFee: feeEntry?.craftFee ?? 0 };
                }));
            }
        }).catch(err => {
             console.error('❌ 加载制作费配置失败:', err);
        });
    }, []);

    // ── 路由参数 ──
    const searchParams = useSearchParams();
    const params = useParams();
    const countryParam = params?.country as string;
    const currentChannelToken = SUPPORTED_COUNTRIES.find(c => c.code.toLowerCase() === countryParam?.toLowerCase())?.channelToken;
    const templateId = searchParams.get('templateId');

    useEffect(() => {
        if (templateId) {
            setLoadingTemplate(true);
            getDesignById(templateId).then(design => {
                if (design) {
                    setName(design.name + ' (Copy)');
                    setMainEffectPreview(design.mainEffectImage || "");
                    
                    if (design.designPairs && design.designPairs.length > 0) {
                        setPairs(design.designPairs.map((p, i) => ({
                            id: String(Date.now() + i),
                            designImage: null,
                            effectImage: null,
                            designPreview: p.designImageUrl,
                            effectPreview: p.effectImageUrl
                        })));
                    }

                    // 同步模板价格和启用状态
                    setCountrySettings(prev => prev.map(c => {
                        const templateSetting = design.priceSettings?.find(ps => ps.channelToken === c.channelToken);
                        return { 
                            ...c, 
                            designFee: templateSetting ? templateSetting.designFee : (design.priceSettings?.[0]?.designFee || 0),
                            enabled: !!templateSetting || (design.priceSettings && design.priceSettings.length === 0)
                        };
                    }));
                }
            }).finally(() => {
                setLoadingTemplate(false);
            });
        }
    }, [templateId]);

    const formatPrice = (code: string, val: any) => {
        const num = Number(val) || 0;
        const symbol = code === 'HU' ? 'Ft' : '€';
        return code === 'HU' ? `${num.toFixed(0)} ${symbol}` : `${num.toFixed(2)} ${symbol}`;
    };

    // ── 主效果图上传 ──
    const mainEffectRef = useRef<HTMLInputElement>(null);
    const handleMainEffectUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setMainEffectImage(file);
            setMainEffectPreview(URL.createObjectURL(file));
        }
    };

    // ── 设计图+效果图配对上传 ──
    const addDesignPair = () => {
        setPairs(prev => [...prev, {
            id: Date.now().toString(),
            designImage: null,
            effectImage: null,
            designPreview: '',
            effectPreview: '',
        }]);
    };

    const updatePairImage = (pairId: string, type: 'design' | 'effect', file: File | null) => {
        setPairs(prev => prev.map(p => {
            if (p.id !== pairId) return p;
            if (!file) {
                return type === 'design'
                    ? { ...p, designImage: null, designPreview: '' }
                    : { ...p, effectImage: null, effectPreview: '' };
            }
            const preview = URL.createObjectURL(file);
            return type === 'design'
                ? { ...p, designImage: file, designPreview: preview }
                : { ...p, effectImage: file, effectPreview: preview };
        }));
    };

    const removePair = (pairId: string) => {
        setPairs(prev => prev.filter(p => p.id !== pairId));
    };

    // ── 表单校验 ──
    const isClone = !!templateId;
    const enabledCountries = countrySettings.filter(c => c.enabled);
    const isValid = name.trim() && enabledCountries.length > 0 && enabledCountries.every(c => c.designFee >= 0) && (
        isClone || (mainEffectImage && pairs.length > 0 && pairs.every(p => p.designImage && p.effectImage))
    );

    // ── 提交发布 ──
    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!isValid || submitting) return;

        setSubmitting(true);
        setResult(null);

        try {
            const authToken = getAuthTokenClient();
            if (!authToken) {
                setResult({ success: false, message: '请先登录 (本地未发现登录凭证，请尝试重新登录)' });
                return;
            }

            const res = await publishDesign({
                name: name.trim(),
                priceSettings: enabledCountries.map(c => ({
                    channelToken: c.channelToken,
                    designFee: c.designFee,
                    stockLevel: c.stockLevel
                })),
                mainEffectImage: mainEffectImage || undefined,
                designPairs: pairs.length > 0 ? pairs.map(p => ({
                    designImage: p.designImage as any,
                    effectImage: p.effectImage as any,
                })) : undefined,
                authToken,
                channelToken: currentChannelToken,
                templateProductId: templateId || undefined,
            });

            setResult({ success: res.success, message: res.message || (res.success ? '发布成功！' : '发布失败') });

            if (res.success) {
                setTimeout(() => { window.location.href = '/vendor/products'; }, 3000);
            }
        } catch (err: any) {
            setResult({ success: false, message: `发布出错: ${err.message}` });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="p-4 max-w-4xl mx-auto pb-20">
            <Link href="/vendor/products" className="text-sm text-blue-600 hover:underline mb-4 inline-block">
                ← 返回我的设计
            </Link>
            <h1 className="text-3xl font-extrabold mb-6 bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-purple-600">
                🎨 发布新设计
            </h1>

            {result && (
                <div className={`mb-6 p-4 rounded-xl shadow-sm border ${result.success
                    ? 'bg-green-50 border-green-200 text-green-800'
                    : 'bg-red-50 border-red-200 text-red-800'
                    }`}>
                    <div className="flex items-center gap-3">
                        <span className="text-xl">{result.success ? '🎉' : '❌'}</span>
                        <p className="font-medium">{result.message}</p>
                    </div>
                </div>
            )}

            {loadingTemplate && (
                <div className="fixed inset-0 bg-white/80 z-[60] flex flex-col items-center justify-center backdrop-blur-sm transition-all duration-300">
                    <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
                    <p className="text-blue-600 font-bold animate-pulse text-lg">正在从模板恢复设计元素...</p>
                    <p className="text-gray-400 text-sm mt-2">正在准备 1:1 复制的高精度模板参数</p>
                </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-8">
                {/* ── 1. 基本信息 ── */}
                <div className="bg-white border rounded-2xl p-6 shadow-sm">
                    <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
                        <span className="bg-blue-100 text-blue-600 w-7 h-7 rounded-lg flex items-center justify-center text-sm">1</span>
                        📝 基本信息
                    </h2>
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-semibold text-gray-700 mb-1.5">设计名称 *</label>
                            <input
                                type="text"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                className="w-full border-gray-200 rounded-xl p-3 bg-gray-50 text-gray-900 focus:bg-white focus:ring-2 focus:ring-blue-500/20 transition-all outline-none"
                                placeholder="给你的设计起个动听的名字..."
                                required
                            />
                        </div>
                    </div>
                </div>

                {/* ── 2. 主图与细节 ── */}
                <div className="grid md:grid-cols-2 gap-8">
                    {/* 总效果大图 */}
                    <div className="bg-white border rounded-2xl p-6 shadow-sm">
                        <h2 className="text-lg font-bold mb-2 flex items-center gap-2">
                            <span className="bg-blue-100 text-blue-600 w-7 h-7 rounded-lg flex items-center justify-center text-sm">2</span>
                            📸 总效果图
                        </h2>
                        <p className="text-xs text-gray-400 mb-4">商品列表主图，建议上传 1:1 图片</p>
                        
                        {mainEffectPreview ? (
                            <div className="relative group aspect-square max-w-[240px] mx-auto">
                                <img src={mainEffectPreview} alt="主效果图" className="w-full h-full object-cover rounded-2xl border shadow-inner" />
                                <button
                                    type="button"
                                    onClick={() => { setMainEffectImage(null); setMainEffectPreview(''); }}
                                    className="absolute -top-3 -right-3 bg-red-500 text-white rounded-full w-8 h-8 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                                >
                                    ×
                                </button>
                            </div>
                        ) : (
                            <div
                                onClick={() => mainEffectRef.current?.click()}
                                className="border-2 border-dashed border-gray-200 rounded-2xl aspect-square flex flex-col items-center justify-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/50 transition-all group max-w-[240px] mx-auto"
                            >
                                <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center text-2xl group-hover:scale-110 transition-transform mb-3">📸</div>
                                <p className="text-sm font-medium text-gray-500">点击上传主图</p>
                            </div>
                        )}
                        <input ref={mainEffectRef} type="file" className="hidden" accept="image/*" onChange={handleMainEffectUpload} />
                    </div>

                    {/* 设计配对 */}
                    <div className="bg-white border rounded-2xl p-6 shadow-sm">
                        <div className="flex justify-between items-center mb-4">
                            <h2 className="text-lg font-bold flex items-center gap-2">
                                <span className="bg-blue-100 text-blue-600 w-7 h-7 rounded-lg flex items-center justify-center text-sm">3</span>
                                🎯 设计配对
                            </h2>
                            <button
                                type="button"
                                onClick={addDesignPair}
                                className="text-blue-600 text-sm font-bold hover:bg-blue-50 px-3 py-1.5 rounded-lg transition"
                            >
                                + 添加配对
                            </button>
                        </div>
                        
                        <div className="space-y-4 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
                            {pairs.map((pair, idx) => (
                                <div key={pair.id} className="bg-gray-50 rounded-xl p-3 border border-gray-100">
                                    <div className="flex justify-between items-center mb-2">
                                        <span className="text-xs font-bold text-gray-400">#0{idx + 1}</span>
                                        <button type="button" onClick={() => removePair(pair.id)} className="text-red-400 hover:text-red-600 text-xs">移除</button>
                                    </div>
                                    <div className="flex gap-3">
                                        {/* 设计图 */}
                                        <div className="flex-1">
                                            {pair.designPreview ? (
                                                <div className="relative h-20 w-full group">
                                                    <img src={pair.designPreview} className="w-full h-full object-cover rounded-lg" />
                                                    <button type="button" onClick={() => updatePairImage(pair.id, 'design', null)} className="absolute inset-0 bg-black/40 text-white opacity-0 group-hover:opacity-100 flex items-center justify-center rounded-lg text-xs transition">更换</button>
                                                </div>
                                            ) : (
                                                <label className="h-20 w-full border border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center cursor-pointer hover:bg-white transition text-[10px] text-gray-400">
                                                    <span>上传设计</span>
                                                    <input type="file" className="hidden" accept="image/*" onChange={e => e.target.files?.[0] && updatePairImage(pair.id, 'design', e.target.files[0])} />
                                                </label>
                                            )}
                                        </div>
                                        {/* 效果图 */}
                                        <div className="flex-1">
                                            {pair.effectPreview ? (
                                                <div className="relative h-20 w-full group">
                                                    <img src={pair.effectPreview} className="w-full h-full object-cover rounded-lg" />
                                                    <button type="button" onClick={() => updatePairImage(pair.id, 'effect', null)} className="absolute inset-0 bg-black/40 text-white opacity-0 group-hover:opacity-100 flex items-center justify-center rounded-lg text-xs transition">更换</button>
                                                </div>
                                            ) : (
                                                <label className="h-20 w-full border border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center cursor-pointer hover:bg-white transition text-[10px] text-gray-400">
                                                    <span>上传效果</span>
                                                    <input type="file" className="hidden" accept="image/*" onChange={e => e.target.files?.[0] && updatePairImage(pair.id, 'effect', e.target.files[0])} />
                                                </label>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                            {pairs.length === 0 && <div className="text-center py-10 text-gray-300 text-sm">尚未添加设计配对</div>}
                        </div>
                    </div>
                </div>

                {/* ── 3. 多国定价 ── */}
                <div className="bg-white border rounded-2xl p-6 shadow-sm overflow-hidden">
                    <h2 className="text-lg font-bold mb-6 flex items-center gap-2">
                        <span className="bg-blue-100 text-blue-600 w-7 h-7 rounded-lg flex items-center justify-center text-sm">4</span>
                        🌍 多国渠道定价
                    </h2>

                    <div className="space-y-6">
                        {countrySettings.map((country, idx) => (
                            <div key={country.code} className={`p-5 rounded-2xl border transition-all ${country.enabled ? 'border-blue-200 bg-blue-50/20' : 'border-gray-100 opacity-60'}`}>
                                <div className="flex items-start gap-4">
                                    <div className="mt-1">
                                        <input
                                            type="checkbox"
                                            checked={country.enabled}
                                            onChange={e => {
                                                const checked = e.target.checked;
                                                setCountrySettings(prev => prev.map(c => c.code === country.code ? { ...c, enabled: checked } : c));
                                            }}
                                            className="w-5 h-5 rounded-md text-blue-600 focus:ring-blue-500 cursor-pointer"
                                        />
                                    </div>
                                    <div className="flex-1">
                                        <div className="flex justify-between items-center mb-4">
                                            <div className="flex items-center gap-2">
                                                <span className="text-2xl">{country.flag}</span>
                                                <span className="font-bold text-gray-800">{country.name}</span>
                                                <span className="text-xs bg-gray-200 text-gray-500 px-2 py-0.5 rounded-full">{country.currency}</span>
                                            </div>
                                            {country.enabled && (
                                                <div className="text-right">
                                                    <p className="text-[10px] uppercase tracking-widest text-gray-400 font-bold mb-0.5">预估收益</p>
                                                    <p className="text-lg font-black text-green-600">
                                                        {formatPrice(country.code, calculateEarnings(commissions, country.channelToken, country.designFee))}
                                                    </p>
                                                </div>
                                            )}
                                        </div>

                                        {country.enabled && (
                                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 animate-in fade-in slide-in-from-top-2">
                                                <div className="space-y-1.5">
                                                    <label className="text-xs font-bold text-gray-500">设计费 ({country.currency}) *</label>
                                                    <input
                                                        type="number"
                                                        value={country.designFee}
                                                        onChange={e => {
                                                            const raw = e.target.value;
                                                            if (raw === "") {
                                                                setCountrySettings(prev => prev.map(c => c.code === country.code ? { ...c, designFee: "" as any } : c));
                                                                return;
                                                            }
                                                            const val = parseFloat(raw);
                                                            if (isNaN(val)) return;
                                                            setCountrySettings(prev => prev.map(c => c.code === country.code ? { ...c, designFee: val } : c));
                                                        }}
                                                        onBlur={() => {
                                                            setCountrySettings(prev => prev.map(c => (c.code === country.code && (c.designFee as any) === "") ? { ...c, designFee: 0 } : c));
                                                        }}
                                                        className="w-full border-gray-200 rounded-xl p-2.5 outline-none focus:ring-2 focus:ring-blue-500/20 text-gray-900"
                                                        placeholder="输入你的分成部分"
                                                        min="0"
                                                    />
                                                </div>
                                                <div className="space-y-1.5">
                                                    <label className="text-xs font-bold text-gray-500">设计份数 / 限量 (-1为无限) *</label>
                                                    <input
                                                        type="number"
                                                        min="-1"
                                                        value={country.stockLevel}
                                                        onChange={e => {
                                                            const raw = e.target.value;
                                                            if (raw === "") {
                                                                setCountrySettings(prev => prev.map(c => c.code === country.code ? { ...c, stockLevel: "" as any } : c));
                                                                return;
                                                            }
                                                            const val = parseInt(raw);
                                                            if (val < -1) return;
                                                            setCountrySettings(prev => prev.map(c => c.code === country.code ? { ...c, stockLevel: val } : c));
                                                        }}
                                                        onBlur={() => {
                                                            setCountrySettings(prev => prev.map(c => (c.code === country.code && (c.stockLevel as any) === "") ? { ...c, stockLevel: -1 } : c));
                                                        }}
                                                        className="w-full border-gray-200 rounded-xl p-2.5 outline-none focus:ring-2 focus:ring-blue-500/20 text-gray-900"
                                                        placeholder="-1 表示不限量"
                                                    />
                                                </div>
                                                <div className="space-y-1.5">
                                                    <label className="text-xs font-bold text-blue-400">最终零售价</label>
                                                    <div className="w-full bg-blue-100 text-blue-600 rounded-xl p-2.5 font-black">
                                                        {formatPrice(country.code, country.designFee + country.craftFee)}
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* ── 4. 提交按钮 ── */}
                <div className="pt-6 border-t flex justify-center">
                    <div className="w-full">
                         <button
                            type="submit"
                            disabled={!isValid || submitting}
                            className={`w-full rounded-2xl py-4 font-bold text-lg shadow-lg shadow-blue-500/20 transition-all ${isValid && !submitting
                                ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:scale-[1.01] active:scale-[0.99] active:shadow-inner'
                                : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                }`}
                        >
                            {submitting ? (
                                <span className="flex items-center justify-center gap-2">
                                    <svg className="animate-spin h-5 w-5 text-current" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                    正在同步全球渠道...
                                </span>
                            ) : (
                                <span>🚀 同步发布全球各国家渠道 ({enabledCountries.length})</span>
                            )}
                        </button>
                    </div>
                </div>

                {!isValid && (
                    <div className="p-4 bg-orange-50 border border-orange-100 rounded-2xl">
                        <p className="text-xs font-bold text-orange-600 mb-2">👋 还需要完善以下内容后发布：</p>
                        <ul className="text-xs text-orange-500 space-y-1 list-disc list-inside">
                            {!name.trim() && <li>填写设计作品的名称</li>}
                            {enabledCountries.length === 0 && <li>勾选至少一个销售国家</li>}
                            {!mainEffectImage && !isClone && <li>上传主效果大图</li>}
                            {pairs.length === 0 && !isClone && <li>添加至少一个设计+效果配对</li>}
                        </ul>
                    </div>
                )}
            </form>
            
            <style jsx>{`
                .custom-scrollbar::-webkit-scrollbar {
                    width: 4px;
                }
                .custom-scrollbar::-webkit-scrollbar-track {
                    background: transparent;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb {
                    background: #e2e8f0;
                    border-radius: 10px;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                    background: #cbd5e1;
                }
            `}</style>
        </div>
    );
}
