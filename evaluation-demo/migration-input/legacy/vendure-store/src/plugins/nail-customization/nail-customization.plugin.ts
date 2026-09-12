import { PluginCommonModule, VendurePlugin, LanguageCode } from '@vendure/core';
import { NailProfile } from './entities/nail-profile.entity';
import { NailCustomizationService } from './services/nail-customization.service';
import { NailCustomizationResolver, localExtensionSchema } from './api/nail-customization.resolver';
import { OrderLineSubscriber } from './order-line-subscriber';

@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [NailProfile],
    providers: [NailCustomizationService],
    shopApiExtensions: {
        schema: localExtensionSchema,
        resolvers: [NailCustomizationResolver],
    },
    configuration: (config) => {
        // Register TypeORM subscriber
        const dbOptions = config.dbConnectionOptions as any;
        dbOptions.subscribers = [
            ...(dbOptions.subscribers ?? []),
            OrderLineSubscriber,
        ];

        // Add custom fields to OrderLine for nail customization
        config.customFields = {
            ...config.customFields,
            OrderLine: [
                ...(config.customFields?.OrderLine ?? []),
                {
                    name: 'designNumber',
                    type: 'string',
                    defaultValue: '',
                    label: [
                        { languageCode: LanguageCode.zh, value: '设计图名称' },
                        { languageCode: LanguageCode.en, value: 'Design Name' },
                    ],
                    description: [
                        { languageCode: LanguageCode.zh, value: '客户选择的效果图对应的设计图名称（文件名）' },
                        { languageCode: LanguageCode.en, value: 'Selected design name (filename)' },
                    ],
                },
                {
                    name: 'nailSizes',
                    type: 'string',
                    defaultValue: '',
                    label: [
                        { languageCode: LanguageCode.zh, value: '全手尺寸数据' },
                        { languageCode: LanguageCode.en, value: 'Nail Sizes (Full Set)' },
                    ],
                    description: [
                        { languageCode: LanguageCode.zh, value: '格式：finger:model,finger:model...' },
                        { languageCode: LanguageCode.en, value: 'Format: finger:model,finger:model...' },
                    ],
                },
                {
                    name: 'fingerName',
                    type: 'string',
                    defaultValue: '',
                    label: [
                        { languageCode: LanguageCode.zh, value: '手指' },
                        { languageCode: LanguageCode.en, value: 'Finger' },
                    ],
                    description: [
                        { languageCode: LanguageCode.zh, value: '对应的手指代码，如 leftIndex（左手食指）' },
                        { languageCode: LanguageCode.en, value: 'Finger code, e.g. leftIndex' },
                    ],
                },
                {
                    name: 'nailProfileId',
                    type: 'string',
                    defaultValue: '',
                    label: [
                        { languageCode: LanguageCode.zh, value: '指甲档案ID' },
                        { languageCode: LanguageCode.en, value: 'Nail Profile ID' },
                    ],
                },
                {
                    name: 'nailShape',
                    type: 'string',
                    defaultValue: '',
                    label: [
                        { languageCode: LanguageCode.zh, value: '甲型' },
                        { languageCode: LanguageCode.en, value: 'Nail Shape' },
                    ],
                    description: [
                        { languageCode: LanguageCode.zh, value: '甲型代码，如 short-oval（短椭圆）' },
                        { languageCode: LanguageCode.en, value: 'Shape code, e.g. short-oval' },
                    ],
                },
                {
                    name: 'matchedNailModel',
                    type: 'string',
                    defaultValue: '',
                    label: [
                        { languageCode: LanguageCode.zh, value: '甲片型号' },
                        { languageCode: LanguageCode.en, value: 'Nail Tip Model' },
                    ],
                    description: [
                        { languageCode: LanguageCode.zh, value: '自动匹配的甲片出厂型号' },
                        { languageCode: LanguageCode.en, value: 'Auto-matched nail tip factory model number' },
                    ],
                },
                {
                    name: 'specialEffect',
                    type: 'string',
                    defaultValue: 'none',
                    public: true,
                    label: [
                        { languageCode: LanguageCode.zh, value: '特殊效果' },
                        { languageCode: LanguageCode.en, value: 'Special Effect' },
                    ],
                },
                {
                    name: 'surfaceFinish',
                    type: 'string',
                    defaultValue: 'glossy',
                    public: true,
                    label: [
                        { languageCode: LanguageCode.zh, value: '表面处理' },
                        { languageCode: LanguageCode.en, value: 'Surface Finish' },
                    ],
                },
            ],
        };
        return config;
    },
})
export class NailCustomizationPlugin { }
