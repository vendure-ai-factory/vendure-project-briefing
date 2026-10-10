'use client';

import { createContext, useContext, ReactNode, useState } from 'react';
import { CheckoutOrder } from './types';

// Add TargetOrder type for soft merge
export type TargetOrder = {
  id: string;
  code: string;
  shippingAddress?: any;
  shippingMethodId?: string;
  shippingMethodName?: string;
};

interface CustomerAddress {
  id: string;
  fullName?: string | null;
  company?: string | null;
  streetLine1: string;
  streetLine2?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  country: { id: string; code: string; name: string };
  phoneNumber?: string | null;
  defaultShippingAddress?: boolean | null;
  defaultBillingAddress?: boolean | null;
}

interface Country {
  id: string;
  code: string;
  name: string;
}

interface ShippingMethod {
  id: string;
  name: string;
  code: string;
  description?: string | null;
  priceWithTax: number;
}

interface PaymentMethod {
  id: string;
  name: string;
  code: string;
  description?: string | null;
  isEligible: boolean;
  eligibilityMessage?: string | null;
}

interface WorldFirstManifestItem {
  id: string;
  regionCode: string;
  paymentMethodCode: string;
  displayName: string;
  logoUrl: string;
}

interface CheckoutContextType {
  order: CheckoutOrder;
  addresses: CustomerAddress[];
  countries: Country[];
  shippingMethods: ShippingMethod[];
  paymentMethods: PaymentMethod[];
  worldFirstManifest: WorldFirstManifestItem[];
  selectedPaymentMethodCode: string | null;
  setSelectedPaymentMethodCode: (code: string | null) => void;
  isGuest: boolean;
  customer: any | null;
  targetOrder?: TargetOrder | null;
  channelCountryCode: string; // [LTS] 新增：当前网页所属的国家频道代码
}

const CheckoutContext = createContext<CheckoutContextType | null>(null);

interface CheckoutProviderProps {
  children: ReactNode;
  order: CheckoutOrder;
  addresses: CustomerAddress[];
  countries: Country[];
  shippingMethods: ShippingMethod[];
  paymentMethods: PaymentMethod[];
  worldFirstManifest: WorldFirstManifestItem[];
  isGuest: boolean;
  customer: any | null;
  targetOrder?: TargetOrder | null;
  channelCountryCode: string; // [LTS] 新增
}

export function CheckoutProvider({
  children,
  order,
  addresses,
  countries,
  shippingMethods,
  paymentMethods,
  worldFirstManifest,
  isGuest,
  customer,
  targetOrder,
  channelCountryCode, // [LTS] 新增
}: CheckoutProviderProps) {
  const [selectedPaymentMethodCode, setSelectedPaymentMethodCode] = useState<string | null>(
    (paymentMethods?.length === 1) ? paymentMethods[0].code : null
  );

  return (
    <CheckoutContext.Provider
      value={{
        order,
        addresses,
        countries,
        shippingMethods,
        paymentMethods,
        worldFirstManifest,
        selectedPaymentMethodCode,
        setSelectedPaymentMethodCode,
        isGuest,
        customer,
        targetOrder,
        channelCountryCode, // [LTS] 新增
      }}
    >
      {children}
    </CheckoutContext.Provider>
  );
}

export function useCheckout() {
  const context = useContext(CheckoutContext);
  if (!context) {
    throw new Error('useCheckout must be used within CheckoutProvider');
  }
  return context;
}
