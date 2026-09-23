'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Loader2, Truck, Lock } from 'lucide-react';
import { Price } from '@/components/commerce/price';
import { useRouter, useParams } from 'next/navigation';
import { useCheckout } from '../checkout-provider';
import { setShippingMethod as setShippingMethodAction } from '../actions';

interface DeliveryStepProps {
  onComplete: () => void;
  onResetToShipping?: () => void;
}

export default function DeliveryStep({ onComplete, onResetToShipping }: DeliveryStepProps) {
  const router = useRouter();
  const params = useParams();
  const country = params?.country as string;
  const { shippingMethods, order, targetOrder } = useCheckout();
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null);

  // Synchronize state with order.shippingLines on mount and when order/shippingMethods change
  useEffect(() => {
    // Only sync if we don't have a selection yet
    if (selectedMethodId) return;

    // Priority 1: Use what's already in the order
    if (order.shippingLines && order.shippingLines.length > 0) {
      setSelectedMethodId((order.shippingLines[0] as any).shippingMethod.id);
      return;
    }

    // Priority 2: Auto-select only if there's exactly one option
    if (shippingMethods.length === 1) {
      setSelectedMethodId(shippingMethods[0].id);
    }
  }, [order.shippingLines, shippingMethods, selectedMethodId]);
  const [submitting, setSubmitting] = useState(false);

  const handleContinue = async () => {
    if (!selectedMethodId) return;

    setSubmitting(true);
    try {
      await setShippingMethodAction(selectedMethodId);
      router.refresh();
      onComplete();
    } catch (error) {
      console.error('Error setting shipping method:', error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUseTargetOrderDelivery = async () => {
    if (!targetOrder?.shippingMethodId) return;

    setSubmitting(true);
    try {
      await setShippingMethodAction(targetOrder.shippingMethodId);
      router.refresh();
      onComplete();
    } catch (error) {
      console.error('Error setting inherited shipping method:', error);
    } finally {
      setSubmitting(false);
    }
  };

  // --- MERGE MODE: LOCKED DELIVERY ---
  const isMergeMode = !!targetOrder?.shippingMethodId;
  const inheritedMethod = shippingMethods.find(m => m.id === targetOrder?.shippingMethodId);

  if (isMergeMode) {
    if (!inheritedMethod) {
      // WEIGHT OVERFLOW or INELIGIBLE
      return (
        <div className="space-y-6">
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <div className="flex items-start gap-3">
              <Truck className="h-5 w-5 text-amber-600 mt-0.5" />
              <div>
                <h4 className="font-semibold text-amber-900 mb-1">无法合并配送</h4>
                <p className="text-sm text-amber-800 mb-4">
                  抱歉，当前购物车商品与基础订单 ({targetOrder?.code}) 合理合并后，总重量已超过该物流渠道的支持上限。为了保证邮寄安全，请作为独立订单结账。
                </p>
                <Button
                  variant="outline"
                  onClick={async () => {
                    await import('../actions').then(m => m.cancelMerge());
                    router.push(`/${country}/cart`);
                  }}
                  className="w-full border-amber-300 text-amber-700 hover:bg-amber-100"
                >
                  取消合并，作为新订单继续
                </Button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <div className="p-4 bg-blue-50/50 border border-blue-100 rounded-lg">
          <div className="flex items-start gap-3">
            <Lock className="h-5 w-5 text-blue-500 mt-0.5" />
            <div>
              <h4 className="font-semibold text-blue-900 mb-1">合并邮寄方式</h4>
              <p className="text-sm text-blue-700/80 mb-3">
                新加购的商品将自动使用源订单 ({targetOrder.code}) 选定的配送服务。
              </p>
              <Card className="p-4 bg-white/60 border-blue-100/60 shadow-none">
                <div className="flex items-center gap-3">
                  <Truck className="h-5 w-5 text-blue-600" />
                  <div className="flex-1">
                    <p className="font-medium text-gray-900">{targetOrder.shippingMethodName || 'Inherited Shipping'}</p>
                    <p className="text-sm text-gray-500">
                      (已锁定，与基础订单一同发货)
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-blue-700">
                      {inheritedMethod.priceWithTax === 0
                        ? 'FREE'
                        : <Price value={inheritedMethod.priceWithTax} currencyCode={order.currencyCode} />}
                    </p>
                    <p className="text-[10px] text-gray-400 font-normal">补交运费 (Supplemental)</p>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </div>

        <Button
          onClick={handleUseTargetOrderDelivery}
          disabled={submitting}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white"
        >
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Continue to payment
        </Button>
      </div>
    );
  }

  if (shippingMethods.length === 0) {
    return (
      <div className="text-center py-8 space-y-4">
        <p className="text-muted-foreground">No shipping methods available. Please check your address.</p>
        <Button 
          variant="outline" 
          onClick={onResetToShipping}
          className="mt-2"
        >
          返回修改地址 / Back to edit address
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h3 className="font-semibold">Select shipping method</h3>

      <RadioGroup value={selectedMethodId || ''} onValueChange={setSelectedMethodId}>
        {shippingMethods.map((method) => (
          <Label key={method.id} htmlFor={method.id} className="cursor-pointer">
            <Card className="p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 flex-1">
                  <RadioGroupItem value={method.id} id={method.id} />
                  <Truck className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium">{method.name}</p>
                    {method.description && (
                      <p className="text-sm text-muted-foreground mt-1">
                        {method.description}
                      </p>
                    )}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="font-semibold">
                    {method.priceWithTax === 0
                      ? 'FREE'
                      : <Price value={method.priceWithTax} currencyCode={order.currencyCode} />}
                  </p>
                </div>
              </div>
            </Card>
          </Label>
        ))}
      </RadioGroup>

      <Button
        onClick={handleContinue}
        disabled={!selectedMethodId || submitting}
        className="w-full"
      >
        {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Continue to payment
      </Button>
    </div>
  );
}
