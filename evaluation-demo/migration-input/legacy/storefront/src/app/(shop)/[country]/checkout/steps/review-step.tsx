'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, MapPin, Truck, CreditCard, Edit, Mail, AlertTriangle } from 'lucide-react';
import { useCheckout } from '../checkout-provider';
import { placeOrder as placeOrderAction } from '../actions';
import { alignOrderRateAction } from '@/lib/wallet-actions';
import { useParams } from 'next/navigation';
import { Price } from '@/components/commerce/price';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

interface ReviewStepProps {
  onEditStep: (step: 'contact' | 'shipping' | 'delivery' | 'payment') => void;
}

export default function ReviewStep({ onEditStep }: ReviewStepProps) {
  const { order, paymentMethods, selectedPaymentMethodCode, isGuest, targetOrder } = useCheckout();
  const params = useParams();
  const countryCode = params.country as string;
  const [loading, setLoading] = useState(false);
  const [aligning, setAligning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isFxError = error?.includes('汇率波动') || error?.includes('FX Sentinel') || error?.includes('对齐');

  const selectedPaymentMethod = paymentMethods.find(
    (method) => method.code === selectedPaymentMethodCode
  );

  const handlePlaceOrder = async () => {
    if (!selectedPaymentMethodCode) return;

    setLoading(true);
    setError(null);
    try {
      const result = await placeOrderAction(selectedPaymentMethodCode, targetOrder?.id);
      if (result && !result.success) {
        setError(result.message);
        setLoading(false);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('NEXT_REDIRECT')) {
        throw error;
      }
      console.error('Error placing order:', error);
      setError('An unexpected error occurred. Please try again.');
      setLoading(false);
    }
  };

  const handleAlignRate = async () => {
    if (!order.id) return;
    setAligning(true);
    const result = await alignOrderRateAction(order.id, countryCode);
    if (result.success) {
      setError(null);
      // 对齐成功后，通常建议重新获取订单或提示用户再次点击支付
      alert('汇率已对齐！请再次点击“立即下单”以完成支付。');
    } else {
      setError(result.message);
    }
    setAligning(false);
  };

  return (
    <div className="space-y-6">
      <h3 className="font-semibold text-lg">Review your order</h3>

      <div className={`grid grid-cols-1 gap-6 ${isGuest ? 'md:grid-cols-2 lg:grid-cols-4' : 'md:grid-cols-3'}`}>
        {isGuest && order.customer && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-muted-foreground" />
              <h4 className="font-medium">Contact</h4>
            </div>
            <div className="text-sm space-y-3">
              <div>
                <p className="font-medium">
                  {order.customer.firstName} {order.customer.lastName}
                </p>
                <p className="text-muted-foreground">{order.customer.emailAddress}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onEditStep('contact')}
              >
                <Edit className="h-4 w-4 mr-1" />
                Edit
              </Button>
            </div>
          </div>
        )}

        {/* Shipping Address */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-muted-foreground" />
            <h4 className="font-medium">Shipping Address</h4>
          </div>
          {order.shippingAddress ? (
            <div className="text-sm space-y-3">
              <div>
                <p className="font-medium">{order.shippingAddress.fullName}</p>
                <p className="text-muted-foreground">
                  {order.shippingAddress.streetLine1}
                  {order.shippingAddress.streetLine2 && `, ${order.shippingAddress.streetLine2}`}
                </p>
                <p className="text-muted-foreground">
                  {order.shippingAddress.city}, {order.shippingAddress.province} {order.shippingAddress.postalCode}
                </p>
                <p className="text-muted-foreground">{order.shippingAddress.country}</p>
                <p className="text-muted-foreground">{order.shippingAddress.phoneNumber}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onEditStep('shipping')}
                disabled={!!targetOrder}
                className={targetOrder ? 'opacity-50 cursor-not-allowed' : ''}
              >
                <Edit className="h-4 w-4 mr-1" />
                {targetOrder ? 'Locked' : 'Edit'}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No shipping address set</p>
          )}
        </div>

        {/* Delivery Method */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Truck className="h-5 w-5 text-muted-foreground" />
            <h4 className="font-medium">Delivery Method</h4>
          </div>
          {order.shippingLines && order.shippingLines.length > 0 ? (
            <div className="text-sm space-y-3">
              <div>
                <p className="font-medium">{order.shippingLines[0].shippingMethod.name}</p>
                <p className="text-muted-foreground">
                  {order.shippingLines[0].priceWithTax === 0
                    ? 'FREE'
                    : <Price value={order.shippingLines[0].priceWithTax} currencyCode={order.currencyCode} />}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onEditStep('delivery')}
                disabled={!!targetOrder}
                className={targetOrder ? 'opacity-50 cursor-not-allowed' : ''}
              >
                <Edit className="h-4 w-4 mr-1" />
                {targetOrder ? 'Locked' : 'Edit'}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No delivery method selected</p>
          )}
        </div>

        {/* Payment Method */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-muted-foreground" />
            <h4 className="font-medium">Payment Method</h4>
          </div>
          {selectedPaymentMethod ? (
            <div className="text-sm space-y-3">
              <div>
                <p className="font-medium">{selectedPaymentMethod.name}</p>
                {selectedPaymentMethod.description && (
                  <p className="text-muted-foreground mt-1">
                    {selectedPaymentMethod.description}
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onEditStep('payment')}
              >
                <Edit className="h-4 w-4 mr-1" />
                Edit
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No payment method selected</p>
          )}
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>无法完成订单 (Unable to place order)</AlertTitle>
          <AlertDescription>
            <div className="flex flex-col gap-3">
              <p>{error}</p>
              {isFxError && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="w-fit border-red-200 bg-red-50 hover:bg-red-100 text-red-900 font-bold flex gap-2"
                  onClick={handleAlignRate}
                  disabled={aligning}
                >
                  {aligning ? <Loader2 className="h-4 w-4 animate-spin" /> : <span>🔄 立即对齐汇率 (Align Rate)</span>}
                </Button>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}

      <Button
        onClick={handlePlaceOrder}
        disabled={loading || !order.shippingAddress || !order.shippingLines?.length || !selectedPaymentMethodCode}
        size="lg"
        className="w-full"
      >
        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Place Order
      </Button>

      {(!order.shippingAddress || !order.shippingLines?.length || !selectedPaymentMethodCode) && (
        <p className="text-sm text-destructive text-center">
          Please complete all previous steps before placing your order
        </p>
      )}
    </div>
  );
}
