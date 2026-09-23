'use server';

import { query } from '@/lib/vendure/api';
import { TransferBalanceMutation, RequestDesignerStatusMutation, RequestPayoutMutation, VerifyAffiliateKycMutation, AlignOrderRateMutation } from '@/lib/vendure/mutations';
import { getAuthToken } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

// ... (existing actions)

export async function verifyKycAction(country: string) {
    try {
        const token = await getAuthToken();
        const result = await query(VerifyAffiliateKycMutation, {}, { token });

        if (result.data?.verifyAffiliateKyc?.id) {
            revalidatePath(`/${country}/account/wallet`);
            revalidatePath(`/${country}/account/wallet/withdraw`);
            revalidatePath(`/${country}/account/kyc`);
            return { success: true, message: '身份验证成功！限制已解除。' };
        } else {
            return { success: false, message: '验证过程发生异常' };
        }
    } catch (e: any) {
        return { success: false, message: e.message || '网络通讯异常' };
    }
}

export async function requestDesignerStatusAction(prevState: any, formData: FormData) {
    const agbVersion = formData.get('agbVersion') as string || 'v2026.04';
    const country = formData.get('country') as string || 'DE';

    try {
        const token = await getAuthToken();
        const result = await query(RequestDesignerStatusMutation, {
            agbVersion
        }, { token });

        if (result.data?.requestDesignerStatus?.success) {
            revalidatePath(`/${country}/account/wallet`);
            return { success: true, message: '申请成功！您现在可以进行提现操作。' };
        } else {
            return { success: false, message: result.data?.requestDesignerStatus?.message || '申请失败' };
        }
    } catch (e: any) {
        return { success: false, message: e.message || '网络请求故障' };
    }
}

export async function requestPayoutAction(prevState: any, formData: FormData) {
    const amountStr = formData.get('amount') as string;
    const wfAccountId = formData.get('wfAccountId') as string;
    const currencyCode = formData.get('currencyCode') as string || 'EUR';
    const country = formData.get('country') as string || 'DE';
    const methodCode = 'worldfirst';

    const multiplier = (currencyCode === 'HUF') ? 1 : 100;
    const amount = Math.round(parseFloat(amountStr) * multiplier);

    try {
        const token = await getAuthToken();
        const result = await query(RequestPayoutMutation, {
            input: {
                amount,
                currencyCode,
                methodCode,
                metadata: {
                    wfAccountId
                }
            }
        }, { token });

        if (result.data?.requestPayout?.success) {
            revalidatePath(`/${country}/account/wallet`);
            revalidatePath(`/${country}/account/wallet/withdraw`);
            return { success: true, message: result.data.requestPayout.message };
        } else {
            return { success: false, message: result.data?.requestPayout?.message || '提现执行失败' };
        }
    } catch (e: any) {
        return { success: false, message: e.message || '网络通讯异常' };
    }
}

export async function transferBalanceAction(prevState: any, formData: FormData) {
    const receiverEmail = (formData.get('receiverEmail') as string || '').trim();
    const amountStr = formData.get('amount') as string;
    const currencyCode = formData.get('currencyCode') as string || 'EUR';
    const country = formData.get('country') as string || 'DE';

    if (!receiverEmail || !amountStr) {
        return { success: false, message: '接收者邮箱和金额不能为空' };
    }

    const multiplier = (currencyCode === 'HUF') ? 1 : 100;
    const amount = Math.round(parseFloat(amountStr) * multiplier);

    if (isNaN(amount) || amount <= 0) {
        return { success: false, message: '金额必须为正数' };
    }

    try {
        const token = await getAuthToken();
        const result = await query(TransferBalanceMutation, {
            receiverEmail,
            amount
        }, { token });
        
        if (result.data?.transferBalance?.success) {
            revalidatePath(`/${country}/account/wallet`);
            revalidatePath(`/${country}/account/wallet/transfer`);
            return { success: true, message: `${result.data.transferBalance.message}。您的资产状态已同步。` };
        } else {
            return { success: false, message: result.data?.transferBalance?.message || '转账失败' };
        }
    } catch (e: any) {
        return { success: false, message: e.message || '转账操作失败' };
    }
}
export async function alignOrderRateAction(orderId: string, country: string) {
    if (!orderId) return { success: false, message: '订单 ID 缺失' };

    try {
        const baseUrl = process.env.VENDURE_API_URL?.replace('/shop-api', '') || 'http://localhost:54321';
        const response = await fetch(`${baseUrl}/tax-integration/align?orderId=${orderId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            }
        });

        if (response.ok) {
            revalidatePath(`/${country}/checkout`);
            return { success: true, message: '汇率已成功对齐！您可以继续支付。' };
        } else {
            return { success: false, message: '对齐操作失败，请稍后重试' };
        }
    } catch (e: any) {
        return { success: false, message: e.message || '网络通讯故障' };
    }
}
