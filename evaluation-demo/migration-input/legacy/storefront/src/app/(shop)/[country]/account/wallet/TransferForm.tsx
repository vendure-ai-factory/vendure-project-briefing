'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { transferBalanceAction } from '@/lib/wallet-actions';
import { formatPrice } from '@/lib/format';

type TransferFormProps = {
    initialBalance: number;
    currencyCode: string;
    country: string;
};

export default function TransferForm({ initialBalance, currencyCode, country }: TransferFormProps) {
    const [state, formAction] = useActionState(transferBalanceAction, null);

    return (
        <form action={formAction} className="space-y-4">
            <input type="hidden" name="country" value={country} />
            <input type="hidden" name="currencyCode" value={currencyCode} />

            <div className="bg-white dark:bg-gray-900 border rounded-2xl p-6 shadow-sm mb-4">
                <div className="mb-6">
                    <p className="text-sm text-muted-foreground mb-1">当前总可用资产 (AUA + SNA + MCA)</p>
                    <p className="text-3xl font-bold text-blue-600">
                        {formatPrice(initialBalance, currencyCode)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-2 italic">
                        💡 优先扣除赠金和积分，保护您的可提现余额。
                    </p>
                </div>

                {state && (
                    <div className={`p-4 rounded-xl mb-6 text-sm font-medium animate-in fade-in slide-in-from-top-1 ${
                        state.success ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
                    }`}>
                        {state.success ? '✅ ' : '❌ '} {state.message}
                    </div>
                )}

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1">接收者邮箱 (Email)</label>
                        <input
                            name="receiverEmail"
                            type="email"
                            placeholder="user@example.com"
                            className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-gray-50 dark:bg-gray-800"
                            required
                        />
                        <p className="text-[10px] text-muted-foreground mt-1">请输入对方注册时使用的完整邮箱地址</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-1">转账金额</label>
                        <div className="relative">
                            <input
                                name="amount"
                                type="number"
                                step="0.01"
                                placeholder="0.00"
                                className="w-full pl-4 pr-12 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-gray-50 dark:bg-gray-800"
                                required
                            />
                            <span className="absolute right-4 top-2 text-sm text-muted-foreground font-mono">
                                {currencyCode}
                            </span>
                        </div>
                    </div>

                    <SubmitButton />
                </div>
            </div>
        </form>
    );
}

function SubmitButton() {
    const { pending } = useFormStatus();

    return (
        <button
            type="submit"
            disabled={pending}
            className={`w-full font-bold py-3 rounded-xl transition-all shadow-md active:scale-95 flex items-center justify-center gap-2 ${
                pending 
                    ? 'bg-gray-400 cursor-not-allowed text-white' 
                    : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
        >
            {pending ? (
                <>
                    <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    待处理中...
                </>
            ) : (
                '立即确认转账'
            )}
        </button>
    );
}
