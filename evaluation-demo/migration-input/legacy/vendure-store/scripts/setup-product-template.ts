/**
 * 商品属性模板设置脚本
 * 
 * 在 Vendure 后台创建/确认穿戴甲所需的标准 OptionGroup。
 * 运行方式：在 vendure-store 目录下执行
 *   npx ts-node scripts/setup-product-template.ts
 * 
 * 此脚本是幂等的（可多次运行，不会重复创建）。
 */

import fetch from 'node-fetch';

const ADMIN_API = 'http://localhost:3000/admin-api';
const ADMIN_USER = process.env.SUPERADMIN_USERNAME || 'REPLACE_WITH_EVALUATION_ADMIN_USERNAME';
const ADMIN_PASS = process.env.SUPERADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD';

/** 甲型 OptionGroup 定义 */
const NAIL_SHAPE_OPTIONS = [
    { code: 'short-square', nameZh: '短方', nameDe: 'Kurz Quadrat' },
    { code: 'short-oval', nameZh: '短椭圆', nameDe: 'Kurz Oval' },
    { code: 'short-pointed', nameZh: '短尖', nameDe: 'Kurz Spitz' },
    { code: 'short-t', nameZh: '短T', nameDe: 'Kurz T' },
];

async function graphqlRequest(query: string, variables?: any): Promise<any> {
    const res = await fetch(ADMIN_API, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            // 先进行登录获得 token
        },
        body: JSON.stringify({ query, variables }),
    });
    return res.json();
}

async function login(): Promise<string> {
    const result = await graphqlRequest(`
        mutation Login($username: String!, $password: String!) {
            login(username: $username, password: $password) {
                ... on CurrentUser {
                    id
                }
                ... on ErrorResult {
                    errorCode
                    message
                }
            }
        }
    `, { username: ADMIN_USER, password: ADMIN_PASS });

    console.log('Login result:', JSON.stringify(result, null, 2));
    return '';
}

async function createNailShapeOptionGroup(authToken: string): Promise<void> {
    console.log('\n=== 创建甲型 OptionGroup ===');

    // 先检查是否已存在
    const checkResult = await graphqlRequest(`
        query {
            productOptionGroups(filterTerm: "nail-shape") {
                id
                code
                name
            }
        }
    `);

    const existing = checkResult?.data?.productOptionGroups?.find(
        (g: any) => g.code === 'nail-shape'
    );

    if (existing) {
        console.log(`✅ 甲型 OptionGroup 已存在 (ID: ${existing.id})`);
        return;
    }

    // 创建 OptionGroup
    const createResult = await graphqlRequest(`
        mutation CreateProductOptionGroup($input: CreateProductOptionGroupInput!) {
            createProductOptionGroup(input: $input) {
                id
                code
                name
                options {
                    id
                    code
                    name
                }
            }
        }
    `, {
        input: {
            code: 'nail-shape',
            translations: [
                { languageCode: 'zh', name: '甲片形状' },
                { languageCode: 'de', name: 'Nagelform' },
                { languageCode: 'en', name: 'Nail Shape' },
            ],
            options: NAIL_SHAPE_OPTIONS.map(opt => ({
                code: opt.code,
                translations: [
                    { languageCode: 'zh', name: opt.nameZh },
                    { languageCode: 'de', name: opt.nameDe },
                    { languageCode: 'en', name: opt.nameZh }, // fallback
                ],
            })),
        },
    });

    if (createResult?.data?.createProductOptionGroup) {
        const group = createResult.data.createProductOptionGroup;
        console.log(`✅ 甲型 OptionGroup 创建成功 (ID: ${group.id})`);
        group.options.forEach((opt: any) => {
            console.log(`   - ${opt.code}: ${opt.name} (ID: ${opt.id})`);
        });
    } else {
        console.error('❌ 创建失败:', JSON.stringify(createResult, null, 2));
    }
}

async function createNailArtFacet(): Promise<void> {
    console.log('\n=== 创建穿戴甲商品分类 Facet ===');

    const checkResult = await graphqlRequest(`
        query {
            facets(options: { filter: { code: { eq: "nail-art" } } }) {
                items {
                    id
                    code
                    name
                }
            }
        }
    `);

    const existing = checkResult?.data?.facets?.items?.find(
        (f: any) => f.code === 'nail-art'
    );

    if (existing) {
        console.log(`✅ 穿戴甲 Facet 已存在 (ID: ${existing.id})`);
        return;
    }

    const createResult = await graphqlRequest(`
        mutation CreateFacet($input: CreateFacetInput!) {
            createFacet(input: $input) {
                id
                code
                name
            }
        }
    `, {
        input: {
            code: 'nail-art',
            isPrivate: false,
            translations: [
                { languageCode: 'zh', name: '穿戴甲' },
                { languageCode: 'de', name: 'Press-On Nails' },
                { languageCode: 'en', name: 'Press-On Nails' },
            ],
            values: [
                {
                    code: 'design-set',
                    translations: [
                        { languageCode: 'zh', name: '设计套装' },
                        { languageCode: 'de', name: 'Design-Set' },
                        { languageCode: 'en', name: 'Design Set' },
                    ],
                },
            ],
        },
    });

    if (createResult?.data?.createFacet) {
        console.log(`✅ 穿戴甲 Facet 创建成功 (ID: ${createResult.data.createFacet.id})`);
    } else {
        console.error('❌ 创建失败:', JSON.stringify(createResult, null, 2));
    }
}

async function main() {
    console.log('🔧 穿戴甲商品模板设置脚本');
    console.log('==========================\n');

    try {
        const token = await login();
        await createNailShapeOptionGroup(token);
        await createNailArtFacet();

        console.log('\n✅ 模板设置完成！');
        console.log('\n📝 后续操作指南：');
        console.log('1. 在后台创建新商品时，添加 OptionGroup "甲片形状"');
        console.log('2. 为每个甲型（短方/短椭圆/短尖/短T）创建 Variant');
        console.log('3. 上传 10 张效果图作为商品素材');
        console.log('4. 关联 Facet "穿戴甲 > 设计套装"');
    } catch (error) {
        console.error('❌ 脚本执行失败:', error);
        process.exit(1);
    }
}

main();
