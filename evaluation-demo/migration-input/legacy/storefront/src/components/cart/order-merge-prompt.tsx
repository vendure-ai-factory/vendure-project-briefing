'use client';

import { useState, useEffect } from 'react';
import { checkHasMergeableOrder, getMergeableOrders, setMergeCookieAction, clearMergeCookieAction } from './merge-actions';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Info, Loader2, RefreshCw, CheckCircle2, XCircle, ChevronRight, ShoppingBag } from 'lucide-react';
import { toast } from 'sonner';
import { Price } from '@/components/commerce/price';
import { useRouter, useParams } from 'next/navigation';

export function OrderMergePrompt() {
    const router = useRouter();
    const params = useParams();
    const country = params?.country as string;
    const [status, setStatus] = useState<'idle' | 'checking' | 'found' | 'not_found' | 'error' | 'merging'>('idle');
    const [orders, setOrders] = useState<any[]>([]);
    const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
    const [errorMsg, setErrorMsg] = useState('');
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        // 每次挂载或回退时强制重置状态，防止 Next.js 客户端缓存导致按钮卡在“合并中”
        setStatus('idle'); 
    }, []);

    const fetchOrders = async () => {
        try {
            await clearMergeCookieAction(); // 先清除可能存在的旧状态 (Clear old state first)
            const fetchedOrders = await getMergeableOrders(country);

            setOrders(fetchedOrders);
            if (fetchedOrders.length > 0) {
                setSelectedOrderId(fetchedOrders[0].id);
                setStatus('found');
            } else {
                await clearMergeCookieAction(); // 显式清除环境 (Explicitly clear environment)
                setStatus('not_found');
            }
        } catch (e: any) {
            console.error(e);
            setStatus('error');
            setErrorMsg(e.message || '获取订单列表失败');
        }
    };

    const handleCheck = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setStatus('checking');
        await fetchOrders();
    };

    const handleMerge = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        const targetId = selectedOrderId || (orders.length > 0 ? orders[0].id : null);
        if (!targetId) {
            toast.error('未选择目标订单');
            return;
        }

        const targetOrder = orders.find(o => o.id === targetId);
        if (!targetOrder) {
            toast.error('找不到订单信息');
            return;
        }

        setStatus('merging');
        try {
            await setMergeCookieAction(targetOrder.code);
            
            // 确保跳转到正确的本地化路径 (Ensure redirect to correct localized path)
            const targetCountry = country || targetOrder.shippingAddress?.countryCode?.toLowerCase() || 'de';
            
            toast.success('已准备合并 (Ready to Merge)', {
                description: `即将与订单 ${targetOrder.code} 合并结算，正在跳转...`,
            });
            
            setTimeout(() => {
                router.push(`/${targetCountry}/checkout`);
            }, 1000);
        } catch (e: any) {
            setStatus('found');
            toast.error('设置合并状态失败', { description: e.message });
        }
    };

    if (!mounted) {
        return <div className="mb-6 h-24 bg-gray-50 border border-dashed border-gray-200 rounded-lg animate-pulse" />;
    }

    if (status === 'idle') {
        return (
            <div className="relative z-10 mb-6 p-4 bg-gray-50 border border-dashed border-gray-300 rounded-lg flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                    <RefreshCw className="h-5 w-5 text-gray-500" />
                    <div>
                        <p className="font-semibold text-gray-800 text-sm">想要节省运费？ (Want to save on shipping?)</p>
                        <p className="text-xs text-gray-500">检查是否有可合并的已支付订单 (Check for paid orders to merge)</p>
                    </div>
                </div>
                <Button
                    variant="outline"
                    onClick={handleCheck}
                    className="cursor-pointer relative z-20"
                >
                    立即检查 (Check Now)
                </Button>
            </div>
        );
    }

    if (status === 'checking') {
        return (
            <div className="mb-6 p-4 bg-gray-50 border border-gray-200 rounded-lg flex items-center justify-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                <span className="text-sm text-gray-600 font-medium">正在扫描账户订单... (Scanning your orders...)</span>
            </div>
        );
    }

    if (status === 'not_found') {
        return (
            <div className="mb-6 p-3 bg-green-50 border border-green-100 rounded-lg flex items-center justify-between">
                <div className="flex items-center gap-2 text-green-700 text-sm">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>未发现可合并订单，您可以继续正常结算。 (No mergeable orders found.)</span>
                </div>
                <button onClick={() => setStatus('idle')} className="text-xs text-green-600 underline cursor-pointer ml-4">
                    重新检查
                </button>
            </div>
        );
    }

    if (status === 'error') {
        return (
            <div className="mb-6 p-3 bg-red-50 border border-red-100 rounded-lg flex flex-col gap-2">
                <div className="flex items-center gap-2 text-red-700 text-sm font-medium">
                    <XCircle className="h-4 w-4" />
                    <span>检查时出错: {errorMsg}</span>
                </div>
                <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleCheck}
                    className="self-start"
                >
                    重试 (Retry)
                </Button>
            </div>
        );
    }

    // Found or Merging status
    return (
        <Alert className="relative z-10 mb-6 bg-blue-50 border-blue-200 animate-in fade-in slide-in-from-top-2">
            <Info className="h-5 w-5 text-blue-600" />
            <AlertTitle className="text-blue-800 font-bold mb-2">发现待合并订单 (Unexported Orders Found)</AlertTitle>
            <AlertDescription className="text-blue-700 flex flex-col gap-4">
                <div className="text-sm">
                    <p>您有 {orders.length} 个已支付但尚未发货的订单。建议将当前商品合并至其中一个，以节省重复的运费。</p>
                </div>

                {/* 订单选择列表 */}
                <div className="space-y-2 mt-1">
                    {orders.map((order) => (
                        <div
                            key={order.id}
                            onClick={() => setSelectedOrderId(order.id)}
                            className={`p-3 rounded-lg border transition-all cursor-pointer flex items-center justify-between ${selectedOrderId === order.id
                                ? 'bg-white border-blue-500 shadow-sm ring-1 ring-blue-500/20'
                                : 'bg-white/50 border-gray-200 hover:border-blue-300'
                                }`}
                        >
                            <div className="flex items-center gap-3">
                                <div className={`p-2 rounded-full ${selectedOrderId === order.id ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-400'}`}>
                                    <ShoppingBag className="h-4 w-4" />
                                </div>
                                <div className="flex flex-col">
                                    <span className="font-bold text-gray-900 text-sm">订单号: {order.code}</span>
                                    {order.shippingAddress && (
                                        <span className="text-[10px] text-gray-600 line-clamp-1">
                                            地址: {order.shippingAddress.streetLine1}, {order.shippingAddress.city} ({order.shippingAddress.fullName})
                                        </span>
                                    )}
                                    <span className="text-[10px] text-gray-400">
                                        下单日期: {new Date(order.orderPlacedAt).toLocaleDateString()}
                                    </span>
                                </div>
                            </div>
                            <div className="flex flex-col items-end">
                                <div className="font-bold text-gray-900 text-sm">
                                    <Price value={order.totalWithTax ?? 0} currencyCode={order.currencyCode || 'EUR'} />
                                </div>
                                {selectedOrderId === order.id && (
                                    <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 rounded-full border border-blue-200">已选</span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>

                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-2 border-t border-blue-100/50 mt-1">
                    <p className="text-[11px] opacity-70 italic sm:max-w-[60%]">
                        合并后，当前购物车商品将追加到选中的订单，余额将更新。
                    </p>
                    <div className="flex items-center gap-3 w-full sm:w-auto">
                        <button
                            onClick={() => setStatus('idle')}
                            className="text-gray-500 hover:text-gray-700 text-sm px-2 cursor-pointer transition-colors"
                        >
                            下次再说
                        </button>
                        <Button
                            onClick={handleMerge}
                            disabled={status === 'merging' || !selectedOrderId}
                            className="bg-blue-600 hover:bg-blue-700 text-white shadow-md flex-1 sm:flex-none min-w-[120px] transition-all transform active:scale-95"
                        >
                            {status === 'merging' ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    合并中...
                                </>
                            ) : (
                                <>
                                    合并并支付 (Merge & Pay)
                                    <ChevronRight className="ml-1 h-4 w-4" />
                                </>
                            )}
                        </Button>
                    </div>
                </div>
            </AlertDescription>
        </Alert>
    );
}
