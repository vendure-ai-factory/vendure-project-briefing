'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Field, FieldLabel, FieldError, FieldGroup } from '@/components/ui/field';
import { useForm, Controller } from 'react-hook-form';
import { Loader2, Lock, AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCheckout } from '../checkout-provider';
import { setShippingAddress, createCustomerAddress } from '../actions';
import { CountrySelect } from '@/components/shared/country-select';
import { CitySelect } from '@/components/shared/city-select';
import { ADDRESS_DATA } from '@/lib/constants/address-data';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

interface ShippingAddressStepProps {
  onComplete: () => void;
}

interface AddressFormData {
  fullName: string;
  streetLine1: string;
  streetLine2?: string;
  city: string;
  province: string;
  postalCode: string;
  countryCode: string;
  phoneNumber: string;
  company?: string;
}

export default function ShippingAddressStep({ onComplete }: ShippingAddressStepProps) {
  const router = useRouter();
  const { addresses, countries, order, isGuest, targetOrder } = useCheckout();

  const allowedCountryCodes = new Set(countries.map(c => c.code));
  const filteredAddresses = addresses.filter(a => allowedCountryCodes.has(a.country.code));

  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [isInitialSync, setIsInitialSync] = useState(true);

  // Synchronize state with order.shippingAddress on mount and when order changes
  useEffect(() => {
    if (filteredAddresses.length === 0) return;

    // Use order address if it exists and we haven't matched yet
    if (order.shippingAddress && isInitialSync) {
      const matchingAddress = filteredAddresses.find(
        (a) =>
          a.fullName?.trim() === order.shippingAddress?.fullName?.trim() &&
          a.streetLine1?.trim() === order.shippingAddress?.streetLine1?.trim() &&
          a.postalCode?.trim() === order.shippingAddress?.postalCode?.trim() &&
          (a.country.code === order.shippingAddress?.countryCode || a.country.name === order.shippingAddress?.country)
      );

      if (matchingAddress) {
        setSelectedAddressId(matchingAddress.id);
        setIsInitialSync(false);
        return;
      }
    }

    // Default selection logic
    if (isInitialSync || !selectedAddressId) {
      const defaultAddress = filteredAddresses.find((a) => a.defaultShippingAddress);
      setSelectedAddressId(defaultAddress?.id || (filteredAddresses.length > 0 ? filteredAddresses[0].id : null));
      setIsInitialSync(false);
    }
  }, [order.shippingAddress, filteredAddresses, isInitialSync, selectedAddressId]);

  const [dialogOpen, setDialogOpen] = useState(filteredAddresses.length === 0 && !isGuest);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [useSameForBilling, setUseSameForBilling] = useState(true);

  const getDefaultFormValues = (): Partial<AddressFormData> => {
    const customerFullName = order.customer
      ? `${order.customer.firstName} ${order.customer.lastName}`.trim()
      : '';

    if (isGuest && order.shippingAddress?.streetLine1) {
      return {
        fullName: order.shippingAddress.fullName || customerFullName,
        streetLine1: order.shippingAddress.streetLine1 || '',
        streetLine2: order.shippingAddress.streetLine2 || '',
        city: order.shippingAddress.city || '',
        province: order.shippingAddress.province || '',
        postalCode: order.shippingAddress.postalCode || '',
        countryCode: countries.find(c => c.name === order.shippingAddress?.country)?.code || countries[0]?.code || 'US',
        phoneNumber: order.shippingAddress.phoneNumber || order.customer?.phoneNumber || '',
        company: order.shippingAddress.company || '',
      };
    }
    return {
      fullName: customerFullName,
      countryCode: countries[0]?.code || 'US',
      phoneNumber: order.customer?.phoneNumber || '',
    };
  };

  const { register, handleSubmit, formState: { errors }, reset, control, watch, setValue, trigger } = useForm<AddressFormData>({
    defaultValues: getDefaultFormValues()
  });

  const watchedCountryCode = watch('countryCode');

  // Initialize manual mode based on verification of default country data presence
  const [isManualCity, setIsManualCity] = useState(false);

  useEffect(() => {
    // Check if current country has data
    const hasData = watchedCountryCode && ADDRESS_DATA[watchedCountryCode];
    if (hasData) {
      setIsManualCity(false);
    } else {
      setIsManualCity(true);
    }
  }, [watchedCountryCode]);

  const handleSelectExistingAddress = async () => {
    if (!selectedAddressId) return;

    setLoading(true);
    try {
      const selectedAddress = filteredAddresses.find(a => a.id === selectedAddressId);
      if (!selectedAddress) return;

      console.log(`[Checkout UI] Selecting address: ${selectedAddress.fullName}, ${selectedAddress.country.code}`);

      const result = await setShippingAddress({
        fullName: selectedAddress.fullName || '',
        company: selectedAddress.company || '',
        streetLine1: selectedAddress.streetLine1,
        streetLine2: selectedAddress.streetLine2 || '',
        city: selectedAddress.city || '',
        province: selectedAddress.province || '',
        postalCode: selectedAddress.postalCode || '',
        countryCode: selectedAddress.country.code,
        phoneNumber: selectedAddress.phoneNumber || '',
      }, useSameForBilling);

      router.refresh();
      onComplete();
    } catch (error: any) {
      console.error('Error setting address:', error);
      alert(`保存配送地址失败: ${error.message || '未知错误'}\n(Failed to save address: ${error.message})`);
    } finally {
      setLoading(false);
    }
  };

  const handleUseTargetOrderAddress = async () => {
    if (!targetOrder?.shippingAddress) return;

    setLoading(true);
    try {
      const addr = targetOrder.shippingAddress;

      await setShippingAddress({
        fullName: addr.fullName || '',
        company: addr.company || '',
        streetLine1: addr.streetLine1 || '',
        streetLine2: addr.streetLine2 || '',
        city: addr.city || '',
        province: addr.province || '',
        postalCode: addr.postalCode || '',
        countryCode: countries.find(c => c.name === addr.country)?.code || countries[0]?.code,
        phoneNumber: addr.phoneNumber || '',
      }, useSameForBilling);

      router.refresh();
      onComplete();
    } catch (error) {
      console.error('Error setting inherited address:', error);
    } finally {
      setLoading(false);
    }
  };

  const onSaveNewAddress = async (data: AddressFormData) => {
    setSaving(true);
    try {
      const newAddress = await createCustomerAddress(data);
      setDialogOpen(false);
      reset();
      router.refresh();
      setSelectedAddressId(newAddress.id);
    } catch (error) {
      console.error('Error creating address:', error);
      alert(`Error creating address: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  const onSubmitGuestAddress = async (data: AddressFormData) => {
    setLoading(true);
    try {
      await setShippingAddress(data, useSameForBilling);
      router.refresh();
      onComplete();
    } catch (error) {
      console.error('Error setting address:', error);
    } finally {
      setLoading(false);
    }
  };

  const renderCityField = (fieldName: 'city', hasData: boolean) => {
    if (hasData && !isManualCity && watchedCountryCode) {
      return (
        <div className="space-y-2">
          <Controller
            name={fieldName}
            control={control}
            rules={{ required: 'City is required' }}
            render={({ field }) => (
              <CitySelect
                cities={ADDRESS_DATA[watchedCountryCode].cities}
                value={field.value}
                onValueChange={(val) => {
                  field.onChange(val);
                  trigger(fieldName);
                }}
                onManualEntry={() => {
                  setIsManualCity(true);
                  setValue(fieldName, '');
                }}
              />
            )}
          />
        </div>
      );
    }

    return (
      <div className="space-y-1">
        <Input
          id={fieldName}
          {...register(fieldName, { required: 'City is required' })}
        />
        {hasData && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => setIsManualCity(false)}
          >
            Select from list
          </Button>
        )}
      </div>
    );
  }

  // --- MERGE MODE: LOCKED ADDRESS ---
  if (targetOrder?.shippingAddress) {
    const addr = targetOrder.shippingAddress;
    const isUnsupportedCountry = !countries.find(c => c.name === addr.country);

    return (
      <div className="space-y-6">
        <div className="p-4 bg-blue-50/50 border border-blue-100 rounded-lg">
          <div className="flex items-start gap-3">
            <Lock className="h-5 w-5 text-blue-500 mt-0.5" />
            <div>
              <h4 className="font-semibold text-blue-900 mb-1">合并基础订单 (Merged with Order {targetOrder.code})</h4>
              <p className="text-sm text-blue-700/80 mb-3">
                为了保证您的多件商品能够打包在一起发货，新加购的商品将自动继承源订单的收件信息。
              </p>


              <Card className="p-4 bg-white/60 border-blue-100/60 shadow-none">
                <div className="leading-tight space-y-0 text-sm text-gray-700">
                  <p className="font-medium text-gray-900">{addr.fullName}</p>
                  {addr.company && <p className="text-muted-foreground">{addr.company}</p>}
                  <p className="text-muted-foreground">
                    {addr.streetLine1}
                    {addr.streetLine2 && `, ${addr.streetLine2}`}
                  </p>
                  <p className="text-muted-foreground">
                    {addr.city}, {addr.province} {addr.postalCode}
                  </p>
                  <p className="text-muted-foreground">
                    {addr.country}
                  </p>
                  <p className="text-muted-foreground">{addr.phoneNumber}</p>
                </div>
              </Card>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="same-billing-merge"
            checked={useSameForBilling}
            onCheckedChange={(checked) => setUseSameForBilling(checked === true)}
          />
          <label
            htmlFor="same-billing-merge"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            Use same address for billing
          </label>
        </div>

        <Button
          onClick={handleUseTargetOrderAddress}
          disabled={loading}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white"
        >
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Continue with this address
        </Button>
      </div>
    );
  }

  if (isGuest) {
    return (
      <div className="space-y-6">
        <form onSubmit={handleSubmit(onSubmitGuestAddress)}>
          <FieldGroup>
            <div className="grid grid-cols-2 gap-4">
              <Field className="col-span-2">
                <FieldLabel htmlFor="fullName">Full Name *</FieldLabel>
                <Input
                  id="fullName"
                  {...register('fullName', { required: 'Full name is required' })}
                />
                <FieldError>{errors.fullName?.message}</FieldError>
              </Field>

              <Field className="col-span-2">
                <FieldLabel htmlFor="company">Company</FieldLabel>
                <Input id="company" {...register('company')} />
              </Field>

              <Field className="col-span-2">
                <FieldLabel htmlFor="streetLine1">Street Address *</FieldLabel>
                <Input
                  id="streetLine1"
                  {...register('streetLine1', { required: 'Street address is required' })}
                />
                <FieldError>{errors.streetLine1?.message}</FieldError>
              </Field>

              <Field className="col-span-2">
                <FieldLabel htmlFor="streetLine2">Apartment, suite, etc.</FieldLabel>
                <Input id="streetLine2" {...register('streetLine2')} />
              </Field>

              <Field>
                <FieldLabel htmlFor="countryCode">Country *</FieldLabel>
                <Controller
                  name="countryCode"
                  control={control}
                  rules={{ required: 'Country is required' }}
                  render={({ field }) => (
                    <CountrySelect
                      countries={countries}
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={loading}
                    />
                  )}
                />
                <FieldError>{errors.countryCode?.message}</FieldError>
              </Field>

              <Field>
                <FieldLabel htmlFor="province">State/Province</FieldLabel>
                <Input
                  id="province"
                  {...register('province')}
                />
                <FieldError>{errors.province?.message}</FieldError>
              </Field>

              <Field>
                <FieldLabel htmlFor="city">City *</FieldLabel>
                {renderCityField('city', !!ADDRESS_DATA[watchedCountryCode])}
                <FieldError>{errors.city?.message}</FieldError>
              </Field>

              <Field>
                <FieldLabel htmlFor="postalCode">Postal Code *</FieldLabel>
                <Input
                  id="postalCode"
                  {...register('postalCode', { required: 'Postal code is required' })}
                />
                <FieldError>{errors.postalCode?.message}</FieldError>
              </Field>

              <Field className="col-span-2">
                <FieldLabel htmlFor="phoneNumber">Phone Number *</FieldLabel>
                <Input
                  id="phoneNumber"
                  type="tel"
                  {...register('phoneNumber', { required: 'Phone number is required' })}
                />
                <FieldError>{errors.phoneNumber?.message}</FieldError>
              </Field>
            </div>

            <div className="flex items-center space-x-2 mt-4">
              <Checkbox
                id="same-billing-guest"
                checked={useSameForBilling}
                onCheckedChange={(checked) => setUseSameForBilling(checked === true)}
              />
              <label
                htmlFor="same-billing-guest"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Use same address for billing
              </label>
            </div>

            <Button type="submit" disabled={loading} className="w-full mt-4">
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Continue
            </Button>
          </FieldGroup>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {filteredAddresses.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-semibold">Select a saved address</h3>
          <RadioGroup value={selectedAddressId || ''} onValueChange={setSelectedAddressId}>
            {filteredAddresses.map((address) => (
              <div key={address.id} className="flex items-start space-x-3">
                <RadioGroupItem value={address.id} id={address.id} className="mt-1" />
                <Label htmlFor={address.id} className="flex-1 cursor-pointer">
                  <Card className="p-4">
                    <div className="leading-tight space-y-0">
                      <p className="font-medium">{address.fullName}</p>
                      {address.company && <p className="text-sm text-muted-foreground">{address.company}</p>}
                      <p className="text-sm text-muted-foreground">
                        {address.streetLine1}
                        {address.streetLine2 && `, ${address.streetLine2}`}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {address.city}, {address.province} {address.postalCode}
                      </p>
                      <p className="text-sm text-muted-foreground">{address.country.name}</p>
                      <p className="text-sm text-muted-foreground">{address.phoneNumber}</p>
                    </div>
                  </Card>
                </Label>
              </div>
            ))}
          </RadioGroup>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="same-billing"
              checked={useSameForBilling}
              onCheckedChange={(checked) => setUseSameForBilling(checked === true)}
            />
            <label
              htmlFor="same-billing"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Use same address for billing
            </label>
          </div>

          <div className="flex gap-3">
            <Button
              onClick={handleSelectExistingAddress}
              disabled={!selectedAddressId || loading}
              className="flex-1"
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Continue with selected address
            </Button>

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button type="button" variant="outline">
                  Add new address
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <form onSubmit={handleSubmit(onSaveNewAddress)}>
                  <DialogHeader>
                    <DialogTitle>Add new address</DialogTitle>
                    <DialogDescription>
                      Fill in the form below to add a new shipping address
                    </DialogDescription>
                  </DialogHeader>

                  <FieldGroup className="my-6">
                    <div className="grid grid-cols-2 gap-4">
                      <Field className="col-span-2">
                        <FieldLabel htmlFor="fullName">Full Name</FieldLabel>
                        <Input
                          id="fullName"
                          {...register('fullName')}
                        />
                        <FieldError>{errors.fullName?.message}</FieldError>
                      </Field>

                      <Field className="col-span-2">
                        <FieldLabel htmlFor="company">Company</FieldLabel>
                        <Input id="company" {...register('company')} />
                      </Field>

                      <Field className="col-span-2">
                        <FieldLabel htmlFor="streetLine1">Street Address *</FieldLabel>
                        <Input
                          id="streetLine1"
                          {...register('streetLine1', { required: 'Street address is required' })}
                        />
                        <FieldError>{errors.streetLine1?.message}</FieldError>
                      </Field>

                      <Field className="col-span-2">
                        <FieldLabel htmlFor="streetLine2">Apartment, suite, etc.</FieldLabel>
                        <Input id="streetLine2" {...register('streetLine2')} />
                      </Field>

                      <Field>
                        <FieldLabel htmlFor="countryCode">Country *</FieldLabel>
                        <Controller
                          name="countryCode"
                          control={control}
                          rules={{ required: 'Country is required' }}
                          render={({ field }) => (
                            <CountrySelect
                              countries={countries}
                              value={field.value}
                              onValueChange={field.onChange}
                              disabled={saving}
                            />
                          )}
                        />
                        <FieldError>{errors.countryCode?.message}</FieldError>
                      </Field>

                      <Field>
                        <FieldLabel htmlFor="province">State/Province</FieldLabel>
                        <Input
                          id="province"
                          {...register('province')}
                        />
                        <FieldError>{errors.province?.message}</FieldError>
                      </Field>

                      <Field>
                        <FieldLabel htmlFor="city">City</FieldLabel>
                        {renderCityField('city', !!ADDRESS_DATA[watchedCountryCode])}
                        <FieldError>{errors.city?.message}</FieldError>
                      </Field>

                      <Field>
                        <FieldLabel htmlFor="postalCode">Postal Code</FieldLabel>
                        <Input
                          id="postalCode"
                          {...register('postalCode')}
                        />
                        <FieldError>{errors.postalCode?.message}</FieldError>
                      </Field>

                      <Field className="col-span-2">
                        <FieldLabel htmlFor="phoneNumber">Phone Number</FieldLabel>
                        <Input
                          id="phoneNumber"
                          type="tel"
                          {...register('phoneNumber')}
                        />
                        <FieldError>{errors.phoneNumber?.message}</FieldError>
                      </Field>
                    </div>
                  </FieldGroup>

                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={saving}>
                      {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Save address
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      )}

      {filteredAddresses.length === 0 && (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <form onSubmit={handleSubmit(onSaveNewAddress)}>
              <DialogHeader>
                <DialogTitle>Add shipping address</DialogTitle>
                <DialogDescription>
                  Fill in the form below to add your shipping address
                </DialogDescription>
              </DialogHeader>

              <FieldGroup className="my-6">
                <div className="grid grid-cols-2 gap-4">
                  <Field className="col-span-2">
                    <FieldLabel htmlFor="fullName">Full Name *</FieldLabel>
                    <Input
                      id="fullName"
                      {...register('fullName', { required: 'Full name is required' })}
                    />
                    <FieldError>{errors.fullName?.message}</FieldError>
                  </Field>

                  <Field className="col-span-2">
                    <FieldLabel htmlFor="company">Company</FieldLabel>
                    <Input id="company" {...register('company')} />
                  </Field>

                  <Field className="col-span-2">
                    <FieldLabel htmlFor="streetLine1">Street Address *</FieldLabel>
                    <Input
                      id="streetLine1"
                      {...register('streetLine1', { required: 'Street address is required' })}
                    />
                    <FieldError>{errors.streetLine1?.message}</FieldError>
                  </Field>

                  <Field className="col-span-2">
                    <FieldLabel htmlFor="streetLine2">Apartment, suite, etc.</FieldLabel>
                    <Input id="streetLine2" {...register('streetLine2')} />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="countryCode">Country *</FieldLabel>
                    <Controller
                      name="countryCode"
                      control={control}
                      rules={{ required: 'Country is required' }}
                      render={({ field }) => (
                        <CountrySelect
                          countries={countries}
                          value={field.value}
                          onValueChange={field.onChange}
                          disabled={saving}
                        />
                      )}
                    />
                    <FieldError>{errors.countryCode?.message}</FieldError>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="province">State/Province</FieldLabel>
                    <Input
                      id="province"
                      {...register('province')}
                    />
                    <FieldError>{errors.province?.message}</FieldError>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="city">City *</FieldLabel>
                    {renderCityField('city', !!ADDRESS_DATA[watchedCountryCode])}
                    <FieldError>{errors.city?.message}</FieldError>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="postalCode">Postal Code *</FieldLabel>
                    <Input
                      id="postalCode"
                      {...register('postalCode', { required: 'Postal code is required' })}
                    />
                    <FieldError>{errors.postalCode?.message}</FieldError>
                  </Field>

                  <Field className="col-span-2">
                    <FieldLabel htmlFor="phoneNumber">Phone Number *</FieldLabel>
                    <Input
                      id="phoneNumber"
                      type="tel"
                      {...register('phoneNumber', { required: 'Phone number is required' })}
                    />
                    <FieldError>{errors.phoneNumber?.message}</FieldError>
                  </Field>
                </div>
              </FieldGroup>

              <DialogFooter>
                <Button type="submit" disabled={saving} className="w-full">
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save address
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
