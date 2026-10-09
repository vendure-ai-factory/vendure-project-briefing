'use client';

import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { CreditCard, ShieldCheck, Globe } from 'lucide-react';
import { useCheckout } from '../checkout-provider';
import { Price } from '@/components/commerce/price';
import { convertCurrency, AVAILABLE_COUNTRIES } from '@/lib/vendure/api';
import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

interface PaymentStepProps {
  onComplete: () => void;
}

export default function PaymentStep({ onComplete }: PaymentStepProps) {
  const { 
    paymentMethods, 
    worldFirstManifest,
    selectedPaymentMethodCode, 
    setSelectedPaymentMethodCode,
    order,
    customer,
    isGuest,
    channelCountryCode // [LTS] 新增
  } = useCheckout();

  // [LTS-HARDENING] 合规侦测：比对收货地址与频道国家
  const shippingCountry = order.shippingAddress?.countryCode?.toUpperCase();
  const channelCountry = channelCountryCode?.toUpperCase();
  const isCountryMismatch = !!(shippingCountry && channelCountry && shippingCountry !== channelCountry);

  const handleContinue = () => {
    if (!selectedPaymentMethodCode || isCountryMismatch) return;
    onComplete();
  };

  if (paymentMethods.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">No payment methods available.</p>
      </div>
    );
  }

  // Helper to render a payment card
  const renderPaymentCard = (method: { id: string, name: string, code: string, radioValue: string, description?: string | null, logoUrl?: string }) => {
    const isWallet = method.code === 'wallet-payment';
    const walletBalance = !isGuest && customer?.customFields
      ? (customer.customFields.balanceBonus || 0) + (customer.customFields.balanceWithdrawable || 0)
      : 0;

    const walletCountryCode = customer?.customFields?.countryCode || 'DE';
    const walletCurrency = AVAILABLE_COUNTRIES.find(c => c.code === walletCountryCode)?.currency || 'EUR';
    const orderCurrency = order.currencyCode;
    const amountInWalletCurrency = convertCurrency(order.totalWithTax, orderCurrency, walletCurrency);
    const hasSufficientBalance = isWallet ? walletBalance >= amountInWalletCurrency : true;

    return (
      <Label key={method.id + method.radioValue} htmlFor={method.id + method.radioValue} className={`cursor-pointer ${isWallet && !hasSufficientBalance ? 'opacity-50 pointer-events-none' : ''}`}>
        <Card className={`p-4 transition-all ${selectedPaymentMethodCode === method.radioValue ? 'border-primary ring-1 ring-primary/20 bg-primary/5' : ''}`}>
          <div className="flex items-start gap-4">
            <RadioGroupItem value={method.radioValue} id={method.id + method.radioValue} disabled={(isWallet && !hasSufficientBalance) || isCountryMismatch} className="mt-1" />
            
            {method.logoUrl ? (
               <img src={method.logoUrl} alt={method.name} className="h-8 w-12 object-contain bg-white rounded p-0.5 border" />
            ) : method.code === 'worldfirst-payment' ? (
              <div className="p-1 px-2 bg-blue-600 rounded text-white font-black text-xs drop-shadow-sm flex items-center justify-center h-8 w-12">
                WF
              </div>
            ) : (
              <div className="p-1 px-2 bg-muted rounded flex items-center justify-center h-8 w-12 text-muted-foreground">
                <CreditCard className="h-5 w-5" />
              </div>
            )}

            <div className="flex-1">
              <p className="font-bold text-base">{method.name}</p>
              {method.code === 'worldfirst-payment' && (
                <p className="text-xs text-blue-600 font-medium mt-0.5">
                   <span className="px-1 py-0.5 bg-blue-100 rounded text-[9px] mr-1 uppercase">Instant Guarantee</span>
                   由万里汇（WorldFirst）提供支付保障
                </p>
              )}
              {method.description && (
                <p className="text-sm text-muted-foreground mt-1">{method.description}</p>
              )}
              
              {isWallet && !isGuest && (
                <div className="mt-2 p-2 bg-muted/40 rounded border text-sm">
                  <div className="flex justify-between">
                    <span>Balance:</span>
                    <span className="font-bold"><Price value={walletBalance} currencyCode={walletCurrency} /></span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>
      </Label>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-xl tracking-tight">支付方式 / Payment</h3>
        <p className="text-xs text-muted-foreground">Secure Checkout via WorldFirst</p>
      </div>

      {isCountryMismatch && (
        <Alert variant="destructive" className="bg-red-50 border-red-200">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle className="font-bold">地址合规冲突 (Compliance Error)</AlertTitle>
          <AlertDescription className="text-sm">
            当前频道为 **{channelCountry}**，但收货地址位于 **{shippingCountry}**。<br/>
            受万里汇合规限制，您必须切换至正确的国家频道才能继续支付。
          </AlertDescription>
        </Alert>
      )}

      <RadioGroup value={selectedPaymentMethodCode || ''} onValueChange={setSelectedPaymentMethodCode} className="grid grid-cols-1 gap-4">
        {paymentMethods.flatMap((method) => {
          if (method.code === 'worldfirst-payment' && worldFirstManifest.length > 0) {
            // Expand worldfirst-payment into manifest sub-items with unique composite IDs
            return worldFirstManifest.map(item => renderPaymentCard({
               id: item.id,
               name: item.displayName,
               code: 'worldfirst-payment', 
               radioValue: `worldfirst-payment:${item.paymentMethodCode}`,
               description: `WorldFirst Checkout via ${item.displayName}`,
               logoUrl: item.logoUrl
            }));
          }
          return [renderPaymentCard({
            ...method,
            radioValue: method.code
          })];
        })}
      </RadioGroup>

      <Button
        onClick={handleContinue}
        disabled={!selectedPaymentMethodCode || isCountryMismatch}
        className="w-full h-12 text-lg font-bold shadow-lg transition-transform active:scale-[0.98]"
      >
        {isCountryMismatch ? '请匹配频道与收货国家' : 'Continue to review'}
      </Button>
    </div>
  );
}
