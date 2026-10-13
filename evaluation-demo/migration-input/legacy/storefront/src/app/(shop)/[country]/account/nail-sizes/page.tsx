import { NailSizesClient } from './nail-sizes-client';

export const metadata = {
    title: '我的指甲尺寸 | 穿戴甲商城',
    description: '管理您的指甲尺寸档案，购买穿戴甲时自动匹配合适型号',
};

/**
 * /account/nail-sizes 页面
 * 
 * 客户登录后在此录入和管理指甲弧长数据。
 * 支持创建多套档案（如"我的指甲"、"女儿的指甲"）。
 */
export default function NailSizesPage() {
    return (
        <div className="container max-w-2xl py-8">
            <NailSizesClient />
        </div>
    );
}
