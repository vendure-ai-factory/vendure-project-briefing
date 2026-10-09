'use client';

import { useActionState, useEffect } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { requestDesignerStatusAction } from '@/lib/wallet-actions';

export default function ApplyPayoutButton({ country }: { country: string }) {
    const [state, formAction] = useActionState(requestDesignerStatusAction, null);
    const router = useRouter();

    useEffect(() => {
        if (state?.success) {
            router.refresh();
        }
    }, [state?.success, router]);

    return (
        <div className="mt-4 p-4 border rounded-xl bg-blue-50 dark:bg-blue-900/10 border-blue-200">
            <h3 className="text-sm font-bold text-blue-800 dark:text-blue-200 mb-2">⚖️ 税务义务与提现声明</h3>
            <p className="text-xs text-blue-700 dark:text-blue-300 mb-4 leading-relaxed">
                点击“申请提现功能”即表示您同意以下条款：<br/>
                1. 您确认自己具有合法的收款权利，并负责申报相关收入。根据欧盟法律，我们将为您生成自开票（Gutschrift）。<br/>
                2. 您承诺提供的身份信息真实有效，提现金额将进入待审核队列。<br/>
                3. 我们将根据您的税务所属地（{country}）自动处理代扣代缴或反向征税逻辑。
            </p>
            
            <form action={formAction}>
                <input type="hidden" name="country" value={country} />
                <input type="hidden" name="agbVersion" value="v2026.04-compliance" />
                
                {state?.success ? (
                    <div className="bg-green-100 text-green-800 p-2 rounded text-sm mb-2">
                        {state.message}
                    </div>
                ) : state?.message ? (
                    <div className="bg-red-100 text-red-800 p-2 rounded text-sm mb-2">
                        {state.message}
                    </div>
                ) : null}

                <SubmitButton />
            </form>
        </div>
    );
}

function SubmitButton() {
    const { pending } = useFormStatus();

    return (
        <button
            type="submit"
            disabled={pending}
            className={`px-4 py-2 text-sm font-bold rounded-lg transition-all ${
                pending 
                    ? 'bg-gray-400 cursor-not-allowed text-white' 
                    : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
        >
            {pending ? '处理中...' : '我已阅读并申请开通提现功能'}
        </button>
    );
}
