'use client';

import { useState, useEffect } from 'react';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Ruler, User, AlertCircle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

// 手指显示名称
const FINGER_LABELS: Record<string, string> = {
    leftThumb: '左拇指', leftIndex: '左食指', leftMiddle: '左中指',
    leftRing: '左无名指', leftPinky: '左小指',
    rightThumb: '右拇指', rightIndex: '右食指', rightMiddle: '右中指',
    rightRing: '右无名指', rightPinky: '右小指',
};

const FINGER_ORDER = [
    'leftThumb', 'leftIndex', 'leftMiddle', 'leftRing', 'leftPinky',
    'rightThumb', 'rightIndex', 'rightMiddle', 'rightRing', 'rightPinky',
];

interface NailShapeOption {
    code: string;
    name: string;
}

interface NailProfile {
    id: string;
    profileName: string;
    fingerSizes: Record<string, number>;
}

interface MatchResult {
    finger: string;
    arcLength: number;
    matchedModel: string;
    exact: boolean;
}

interface NailSizeSelectorProps {
    /** 可用甲型列表（来自 Vendure OptionGroup） */
    shapes: NailShapeOption[];
    /** 用户已保存的指甲档案 */
    profiles: NailProfile[];
    /** 选中的甲型 */
    selectedShape: string | null;
    /** 选中的档案 */
    selectedProfileId: string | null;
    /** 选中的手指 (单选) */
    selectedFinger: string | null;
    /** 匹配结果 */
    matchResults: MatchResult[];
    /** 是否正在加载 */
    loading?: boolean;
    /** 甲型选择变更 */
    onShapeChange: (shapeCode: string) => void;
    /** 档案选择变更 */
    onProfileChange: (profileId: string) => void;
    /** 手指选择变更 */
    onFingerSelect: (finger: string) => void;
    /** 跳转到尺寸管理页面 */
    onManageProfiles: () => void;
}

/**
 * 甲片尺寸选择器 (Nail Size Selector)
 * 
 * 用于商品详情页，让客户：
 * 1. 选择甲型（短方/短椭圆/短尖/短T）
 * 2. 选择指甲档案（已保存的尺寸数据）
 * 3. 在匹配结果中选择一个具体要定制的手指
 */
export function NailSizeSelector({
    shapes,
    profiles,
    selectedShape,
    selectedProfileId,
    selectedFinger,
    matchResults,
    loading = false,
    onShapeChange,
    onProfileChange,
    onFingerSelect,
    onManageProfiles,
}: NailSizeSelectorProps) {
    const selectedProfile = profiles.find(p => p.id === selectedProfileId);

    return (
        <div className="space-y-6 border rounded-lg p-4 bg-card">
            {/* ---- 1. 甲型选择 ---- */}
            <div className="space-y-3">
                <Label className="text-base font-semibold flex items-center gap-2">
                    <span>💅</span>
                    选择甲型
                </Label>
                <RadioGroup
                    value={selectedShape || ''}
                    onValueChange={onShapeChange}
                    className="grid grid-cols-2 gap-2"
                >
                    {shapes.map((shape) => (
                        <div key={shape.code} className="flex items-center space-x-2">
                            <RadioGroupItem value={shape.code} id={`shape-${shape.code}`} />
                            <Label
                                htmlFor={`shape-${shape.code}`}
                                className="cursor-pointer text-sm font-normal"
                            >
                                {shape.name}
                            </Label>
                        </div>
                    ))}
                </RadioGroup>
            </div>

            {/* ---- 2. 指甲档案选择 ---- */}
            <div className="space-y-3">
                <Label className="text-base font-semibold flex items-center gap-2">
                    <User className="h-4 w-4" />
                    选择指甲档案
                </Label>

                {profiles.length === 0 ? (
                    <div className="text-center py-4 space-y-3 bg-muted/50 rounded-lg">
                        <div className="flex items-center justify-center gap-2 text-muted-foreground">
                            <AlertCircle className="h-5 w-5" />
                            <span className="text-sm">还没有指甲档案</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            请先录入您的指甲尺寸数据
                        </p>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={onManageProfiles}
                            className="gap-2"
                        >
                            <Ruler className="h-4 w-4" />
                            录入指甲尺寸
                        </Button>
                    </div>
                ) : (
                    <div className="space-y-2">
                        <RadioGroup
                            value={selectedProfileId || ''}
                            onValueChange={onProfileChange}
                        >
                            {profiles.map((profile) => (
                                <div key={profile.id} className="flex items-center space-x-2">
                                    <RadioGroupItem value={profile.id} id={`profile-${profile.id}`} />
                                    <Label
                                        htmlFor={`profile-${profile.id}`}
                                        className="cursor-pointer text-sm font-normal"
                                    >
                                        {profile.profileName}
                                    </Label>
                                </div>
                            ))}
                        </RadioGroup>
                        <Button
                            variant="link"
                            size="sm"
                            onClick={onManageProfiles}
                            className="text-xs p-0 h-auto"
                        >
                            管理指甲档案 →
                        </Button>
                    </div>
                )}
            </div>

            {/* ---- 3. 匹配结果展示 ---- */}
            {selectedShape && selectedProfile && (
                <div className="space-y-3">
                    <Label className="text-base font-semibold flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                        尺寸匹配结果
                    </Label>

                    {loading ? (
                        <div className="text-center py-4 text-muted-foreground text-sm animate-pulse">
                            正在匹配甲片型号...
                        </div>
                    ) : matchResults.length > 0 ? (
                        <div className="grid grid-cols-2 gap-1.5">
                            {/* 左手 */}
                            <div className="space-y-1">
                                <p className="text-xs font-medium text-muted-foreground text-center">左手</p>
                                {FINGER_ORDER.slice(0, 5).map((finger) => {
                                    const result = matchResults.find(r => r.finger === finger);
                                    const userSize = selectedProfile?.fingerSizes?.[finger];

                                    return (
                                        <div
                                            key={finger}
                                            className={`flex items-center justify-between text-xs rounded px-2 py-1.5 cursor-pointer transition-all border-2 ${selectedFinger === finger
                                                    ? 'bg-primary/10 border-primary shadow-sm'
                                                    : 'bg-muted/50 border-transparent hover:bg-muted'
                                                }`}
                                            onClick={() => onFingerSelect(finger)}
                                        >
                                            <span className={selectedFinger === finger ? 'font-bold' : ''}>
                                                {FINGER_LABELS[finger]}
                                            </span>
                                            {result ? (
                                                <Badge
                                                    variant={result.exact ? 'default' : 'secondary'}
                                                    className="text-[10px] px-1.5"
                                                >
                                                    #{result.matchedModel}
                                                    {!result.exact && ' ≈'}
                                                </Badge>
                                            ) : (
                                                <span className="text-muted-foreground">-</span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                            {/* 右手 */}
                            <div className="space-y-1">
                                <p className="text-xs font-medium text-muted-foreground text-center">右手</p>
                                {FINGER_ORDER.slice(5, 10).map((finger) => {
                                    const result = matchResults.find(r => r.finger === finger);
                                    const userSize = selectedProfile?.fingerSizes?.[finger];

                                    return (
                                        <div
                                            key={finger}
                                            className={`flex items-center justify-between text-xs rounded px-2 py-1.5 cursor-pointer transition-all border-2 ${selectedFinger === finger
                                                    ? 'bg-primary/10 border-primary shadow-sm'
                                                    : 'bg-muted/50 border-transparent hover:bg-muted'
                                                }`}
                                            onClick={() => onFingerSelect(finger)}
                                        >
                                            <span className={selectedFinger === finger ? 'font-bold' : ''}>
                                                {FINGER_LABELS[finger]}
                                            </span>
                                            {result ? (
                                                <Badge
                                                    variant={result.exact ? 'default' : 'secondary'}
                                                    className="text-[10px] px-1.5"
                                                >
                                                    #{result.matchedModel}
                                                    {!result.exact && ' ≈'}
                                                </Badge>
                                            ) : (
                                                <span className="text-muted-foreground">-</span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ) : (
                        <p className="text-xs text-muted-foreground text-center">
                            请选择甲型和档案以查看匹配结果
                        </p>
                    )}

                    {matchResults.some(r => !r.exact) && (
                        <p className="text-[10px] text-muted-foreground">
                            💡 带 ≈ 标记表示弧长介于两个型号之间，已自动选择更贴合（较小）的型号
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
