'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { delistDesign } from '@/lib/vendure/vendor';
import { getAuthTokenClient } from '@/lib/auth-client';

// ─── 类型 ─────────────────────────────────────────────────────────────────────

interface DesignProduct {
    productId: string;
    name: string;
    sku: string;
    designFee: number;
    craftFee: number;
    totalPrice: number;
    status: string;
    salesCount: number;
    totalEarnings: number;
    createdAt: string;
    featuredAssetUrl: string | null;
}

// ─── 我的设计列表页面 ─────────────────────────────────────────────────────────

export default function VendorProductsPage() {
    const [products, setProducts] = useState<DesignProduct[]>([]);
    const [loading, setLoading] = useState(true);
    const [delisting, setDelisting] = useState<string | null>(null);

    // 从后端获取数据
    useEffect(() => {
        async function fetchDesigns() {
            try {
                const authToken = getAuthTokenClient();
                if (!authToken) {
                    setLoading(false);
                    return;
                }

                const VENDURE_API_URL = process.env.NEXT_PUBLIC_VENDURE_SHOP_API_URL || 'http://localhost:3000/shop-api';
                const res = await fetch(VENDURE_API_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authToken}`,
                    },
                    body: JSON.stringify({
                        query: `query MyDesigns {
                            myDesigns {
                                productId name sku designFee craftFee totalPrice
                                status salesCount totalEarnings createdAt featuredAssetUrl
                            }
                        }`,
                    }),
                });

                const result = await res.json();
                if (result.data?.myDesigns) {
                    setProducts(result.data.myDesigns);
                }
            } catch (err) {
                console.error('Failed to fetch designs:', err);
            } finally {
                setLoading(false);
            }
        }

        fetchDesigns();
    }, []);

    // 下架操作
    const handleDelist = async (productId: string, productName: string) => {
        if (!confirm(`确定要下架「${productName}」吗？\n\n下架后：\n• 商品将从商城隐藏\n• 已上传的图片将被删除\n• 本地存档文件将保留`)) {
            return;
        }

        setDelisting(productId);
        try {
            const authToken = getAuthTokenClient();
            if (!authToken) {
                alert('请先登录');
                return;
            }

            const success = await delistDesign(productId, authToken);
            if (success) {
                setProducts(prev => prev.map(p =>
                    p.productId === productId ? { ...p, status: 'delisted' } : p
                ));
                alert(`✅ 「${productName}」已下架`);
            } else {
                alert('❌ 下架失败，请稍后重试');
            }
        } catch (err: any) {
            alert(`❌ 下架出错: ${err.message}`);
        } finally {
            setDelisting(null);
        }
    };

    // 格式化价格（内部格式 ÷ 100）
    const formatPrice = (vendurePrice: number) => (vendurePrice / 100).toFixed(2);

    return (
        <div className="p-4 max-w-4xl mx-auto">
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-2xl font-bold">📦 我的设计</h1>
                <Link
                    href="/vendor/products/new"
                    className="bg-gradient-to-r from-blue-600 to-purple-600 text-white px-4 py-2 rounded-lg hover:opacity-90 transition"
                >
                    + 发布新设计
                </Link>
            </div>

            {/* 加载状态 */}
            {loading && (
                <div className="text-center py-12">
                    <p className="text-gray-400">⏳ 加载中...</p>
                </div>
            )}

            {/* 空状态 */}
            {!loading && products.length === 0 && (
                <div className="text-center py-16 border-2 border-dashed rounded-lg">
                    <p className="text-4xl mb-4">🎨</p>
                    <p className="text-gray-500 mb-4">你还没有发布任何设计</p>
                    <Link
                        href="/vendor/products/new"
                        className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 inline-block"
                    >
                        发布第一个设计
                    </Link>
                </div>
            )}

            {/* 商品列表 */}
            {!loading && products.length > 0 && (
                <div className="border rounded-lg divide-y">
                    {products.map(product => (
                        <div key={product.productId} className="p-4 flex justify-between items-center hover:bg-gray-50/50 transition">
                            <div className="flex gap-4 items-center">
                                {/* 商品图片 */}
                                <div className="w-16 h-16 rounded-lg overflow-hidden bg-gray-100 flex items-center justify-center flex-shrink-0">
                                    {product.featuredAssetUrl ? (
                                        <img
                                            src={product.featuredAssetUrl}
                                            alt={product.name}
                                            className="w-full h-full object-cover"
                                        />
                                    ) : (
                                        <span className="text-2xl">🎨</span>
                                    )}
                                </div>
                                <div>
                                    <p className="font-medium">{product.name}</p>
                                    <p className="text-sm text-gray-500">
                                        SKU: {product.sku}
                                    </p>
                                    <p className="text-xs text-gray-400">
                                        设计费: {formatPrice(product.designFee)} € · 制作费: {formatPrice(product.craftFee)} € · 总价: {formatPrice(product.totalPrice)} €
                                    </p>
                                </div>
                            </div>
                            <div className="flex gap-6 items-center">
                                {/* 销量 */}
                                <div className="text-center min-w-[60px]">
                                    <p className="text-xs text-gray-500">销量</p>
                                    <p className="font-bold">{product.salesCount}</p>
                                </div>
                                {/* 累计收入 */}
                                <div className="text-center min-w-[80px]">
                                    <p className="text-xs text-gray-500">累计收入</p>
                                    <p className="font-bold text-green-600">{formatPrice(product.totalEarnings)} €</p>
                                </div>
                                {/* 状态 */}
                                <div>
                                    <span className={`px-2 py-1 rounded text-xs font-medium ${product.status === 'active'
                                            ? 'bg-green-100 text-green-800'
                                            : 'bg-red-100 text-red-800'
                                        }`}>
                                        {product.status === 'active' ? '🟢 在售' : '🔴 已下架'}
                                    </span>
                                </div>
                                {/* 操作按钮 */}
                                {product.status === 'active' && (
                                    <div className="flex gap-2">
                                        <Link
                                            href={`/vendor/products/new?templateId=${product.productId}`}
                                            className="text-sm px-3 py-1 rounded border border-blue-300 text-blue-600 hover:bg-blue-50 transition"
                                        >
                                            修改/克隆
                                        </Link>
                                        <button
                                            onClick={() => handleDelist(product.productId, product.name)}
                                            disabled={delisting === product.productId}
                                            className={`text-sm px-3 py-1 rounded border transition ${delisting === product.productId
                                                    ? 'text-gray-400 border-gray-200 cursor-not-allowed'
                                                    : 'text-red-600 border-red-300 hover:bg-red-50'
                                                }`}
                                        >
                                            {delisting === product.productId ? '下架中...' : '下架'}
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* 统计信息 */}
            {!loading && products.length > 0 && (
                <div className="mt-4 grid grid-cols-3 gap-4">
                    <div className="border rounded-lg p-4 text-center">
                        <p className="text-sm text-gray-500">在售设计</p>
                        <p className="text-2xl font-bold text-blue-600">
                            {products.filter(p => p.status === 'active').length}
                        </p>
                    </div>
                    <div className="border rounded-lg p-4 text-center">
                        <p className="text-sm text-gray-500">总销量</p>
                        <p className="text-2xl font-bold">
                            {products.reduce((sum, p) => sum + p.salesCount, 0)}
                        </p>
                    </div>
                    <div className="border rounded-lg p-4 text-center">
                        <p className="text-sm text-gray-500">累计总收入</p>
                        <p className="text-2xl font-bold text-green-600">
                            {formatPrice(products.reduce((sum, p) => sum + p.totalEarnings, 0))} €
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
