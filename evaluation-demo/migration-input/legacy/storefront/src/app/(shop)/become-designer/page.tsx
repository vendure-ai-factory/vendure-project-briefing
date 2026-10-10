import Link from 'next/link';

// 成为设计师页面
export default function BecomeDesignerPage() {
    return (
        <div className="container mx-auto px-4 py-8 mt-16 max-w-3xl">
            <h1 className="text-3xl font-bold mb-2">✨ 成为设计师</h1>
            <p className="text-muted-foreground mb-8">
                发布你的原创设计，每次销售都能获得收入！
            </p>

            {/* 收入模式说明 */}
            <div className="border rounded-lg p-6 mb-8 bg-gradient-to-r from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20">
                <h2 className="text-xl font-semibold mb-4">💰 收入模式</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <p className="font-medium">设计费归你</p>
                        <p className="text-sm text-muted-foreground">
                            你设置设计图案的价格，每次销售这部分收入全部归你
                        </p>
                    </div>
                    <div>
                        <p className="font-medium">制作费归平台</p>
                        <p className="text-sm text-muted-foreground">
                            穿戴甲的手工制作、邮寄、售后由平台完成
                        </p>
                    </div>
                </div>
            </div>

            {/* 流程说明 */}
            <div className="border rounded-lg p-6 mb-8">
                <h2 className="text-xl font-semibold mb-4">📋 合作流程</h2>
                <div className="space-y-4">
                    <div className="flex gap-4">
                        <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold shrink-0">1</div>
                        <div>
                            <p className="font-medium">你 - 上传设计图案</p>
                            <p className="text-sm text-muted-foreground">上传你的原创美甲设计图，设置价格和描述</p>
                        </div>
                    </div>
                    <div className="flex gap-4">
                        <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold shrink-0">2</div>
                        <div>
                            <p className="font-medium">你 - 线上推广</p>
                            <p className="text-sm text-muted-foreground">通过社交媒体、朋友圈等渠道推广你的设计</p>
                        </div>
                    </div>
                    <div className="flex gap-4">
                        <div className="w-8 h-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center font-bold shrink-0">3</div>
                        <div>
                            <p className="font-medium">消费者下单</p>
                            <p className="text-sm text-muted-foreground">消费者在网站购买你的设计作品</p>
                        </div>
                    </div>
                    <div className="flex gap-4">
                        <div className="w-8 h-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center font-bold shrink-0">4</div>
                        <div>
                            <p className="font-medium">平台 - 制作 & 发货</p>
                            <p className="text-sm text-muted-foreground">我们根据设计手工制作穿戴甲，并邮寄给消费者</p>
                        </div>
                    </div>
                    <div className="flex gap-4">
                        <div className="w-8 h-8 rounded-full bg-green-600 text-white flex items-center justify-center font-bold shrink-0">5</div>
                        <div>
                            <p className="font-medium">你 - 收取设计费</p>
                            <p className="text-sm text-muted-foreground">订单完成后，设计费自动进入你的钱包，可随时提现</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* 申请表单 */}
            <div className="border rounded-lg p-6">
                <h2 className="text-xl font-semibold mb-4">📝 申请入驻</h2>
                <form className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1">设计师名称 *</label>
                        <input
                            type="text"
                            className="w-full border rounded-lg p-3"
                            placeholder="你的品牌名或昵称"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">联系邮箱 *</label>
                        <input
                            type="email"
                            className="w-full border rounded-lg p-3"
                            placeholder="用于接收通知和结算信息"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">社交媒体链接</label>
                        <input
                            type="url"
                            className="w-full border rounded-lg p-3"
                            placeholder="Instagram / 小红书 / 微博等"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">自我介绍</label>
                        <textarea
                            className="w-full border rounded-lg p-3 h-24"
                            placeholder="介绍你的设计风格和经验..."
                        />
                    </div>
                    <button
                        type="submit"
                        className="w-full bg-primary text-primary-foreground rounded-lg p-3 font-medium hover:opacity-90"
                    >
                        提交申请
                    </button>
                </form>
                <p className="text-xs text-muted-foreground mt-4 text-center">
                    提交后我们会在 1-2 个工作日内审核，审核通过后你将收到邮件通知
                </p>
            </div>

            {/* 已有账号 */}
            <div className="mt-6 text-center">
                <p className="text-sm text-muted-foreground">
                    已经是设计师？
                    <Link href="/vendor/dashboard" className="text-blue-600 hover:underline ml-1">
                        进入设计师中心 →
                    </Link>
                </p>
            </div>
        </div>
    );
}
