'use client';

import { useState, useEffect, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { toast } from 'sonner';
import {
    Plus, Save, Trash2, Edit2, X, Hand, Ruler,
} from 'lucide-react';
import {
    getNailProfiles,
    createProfile,
    updateProfile,
    deleteProfile,
} from './actions';

// 手指显示名称和排列
const FINGERS_LEFT = [
    { code: 'leftThumb', label: '拇指' },
    { code: 'leftIndex', label: '食指' },
    { code: 'leftMiddle', label: '中指' },
    { code: 'leftRing', label: '无名指' },
    { code: 'leftPinky', label: '小指' },
];
const FINGERS_RIGHT = [
    { code: 'rightThumb', label: '拇指' },
    { code: 'rightIndex', label: '食指' },
    { code: 'rightMiddle', label: '中指' },
    { code: 'rightRing', label: '无名指' },
    { code: 'rightPinky', label: '小指' },
];

interface NailProfile {
    id: string;
    profileName: string;
    fingerSizes: Record<string, number>;
}

/**
 * 指甲尺寸管理客户端组件
 * 
 * 功能：
 * - 展示所有已保存的指甲档案
 * - 创建新档案（输入 10 个手指的弧长）
 * - 编辑已有档案
 * - 删除档案
 * - 双手可视化布局
 */
export function NailSizesClient() {
    const [profiles, setProfiles] = useState<NailProfile[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const [isPending, startTransition] = useTransition();
    // const { toast } = useToast();

    // 表单状态
    const [formName, setFormName] = useState('');
    const [formSizes, setFormSizes] = useState<Record<string, string>>({});

    // 加载数据
    useEffect(() => {
        loadProfiles();
    }, []);

    async function loadProfiles() {
        const result = await getNailProfiles();
        if (result.success && result.profiles) {
            setProfiles(result.profiles);
        }
    }

    function initForm(profile?: NailProfile) {
        if (profile) {
            setFormName(profile.profileName);
            const sizes: Record<string, string> = {};
            for (const [key, val] of Object.entries(profile.fingerSizes)) {
                sizes[key] = val.toString();
            }
            setFormSizes(sizes);
        } else {
            setFormName('');
            setFormSizes({});
        }
    }

    function handleStartCreate() {
        setIsCreating(true);
        setEditingId(null);
        initForm();
    }

    function handleStartEdit(profile: NailProfile) {
        setEditingId(profile.id);
        setIsCreating(false);
        initForm(profile);
    }

    function handleCancel() {
        setIsCreating(false);
        setEditingId(null);
        initForm();
    }

    function handleSizeChange(finger: string, value: string) {
        setFormSizes(prev => ({ ...prev, [finger]: value }));
    }

    function getFingerSizesAsNumbers(): Record<string, number> | null {
        const sizes: Record<string, number> = {};
        const allFingers = [...FINGERS_LEFT, ...FINGERS_RIGHT];
        for (const finger of allFingers) {
            const val = parseFloat(formSizes[finger.code] || '0');
            // 允许 0 表示未测量，只有在有数值时才检查范围
            if (isNaN(val) || (val !== 0 && (val < 5 || val > 25))) {
                toast.error('数据错误', {
                    description: `${finger.label} 的弧长必须在 5-25mm 之间 (或保持为 0)`,
                });
                return null;
            }
            sizes[finger.code] = val;
        }
        return sizes;
    }

    async function handleSave() {
        if (!formName.trim()) {
            toast.error('请输入档案名称');
            return;
        }
        const sizes = getFingerSizesAsNumbers();
        if (!sizes) return;

        startTransition(async () => {
            if (isCreating) {
                const result = await createProfile(formName.trim(), sizes);
                if (result.success) {
                    toast.success('✅ 档案创建成功');
                    setIsCreating(false);
                    loadProfiles();
                } else {
                    toast.error('创建失败', { description: result.error });
                }
            } else if (editingId) {
                const result = await updateProfile(editingId, {
                    profileName: formName.trim(),
                    fingerSizes: sizes,
                });
                if (result.success) {
                    toast.success('✅ 档案更新成功');
                    setEditingId(null);
                    loadProfiles();
                } else {
                    toast.error('更新失败', { description: result.error });
                }
            }
        });
    }

    async function handleDelete(id: string) {
        startTransition(async () => {
            const result = await deleteProfile(id);
            if (result.success) {
                toast.success('✅ 档案已删除');
                loadProfiles();
            } else {
                toast.error('删除失败', { description: result.error });
            }
        });
    }

    const isEditing = isCreating || editingId !== null;

    return (
        <div className="space-y-6">
            {/* 标题和操作 */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-bold">💅 我的指甲尺寸</h2>
                    <p className="text-sm text-muted-foreground mt-1">
                        录入指甲弧长数据，购买穿戴甲时自动匹配合适型号
                    </p>
                </div>
                {!isEditing && (
                    <Button onClick={handleStartCreate} className="gap-2">
                        <Plus className="h-4 w-4" />
                        添加档案
                    </Button>
                )}
            </div>

            {/* 测量指南 */}
            <Card className="bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800">
                <CardContent className="pt-4 pb-3">
                    <div className="flex items-start gap-3">
                        <Ruler className="h-5 w-5 text-blue-500 mt-0.5" />
                        <div className="text-sm space-y-1">
                            <p className="font-medium text-blue-700 dark:text-blue-300">
                                测量方法
                            </p>
                            <p className="text-blue-600 dark:text-blue-400 text-xs">
                                使用软尺或细线量过指甲最宽处的弧线长度（弧长），单位为毫米(mm)。
                                弧长范围通常在 5-25mm 之间。
                            </p>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* 编辑表单 */}
            {isEditing && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg">
                            {isCreating ? '新建指甲档案' : '编辑指甲档案'}
                        </CardTitle>
                        <CardDescription>
                            请输入 10 个手指的弧长（mm）
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {/* 档案名 */}
                        <div className="space-y-2">
                            <Label htmlFor="profileName">档案名称</Label>
                            <Input
                                id="profileName"
                                value={formName}
                                onChange={(e) => setFormName(e.target.value)}
                                placeholder="例如：我的指甲、女儿的指甲"
                                className="max-w-xs"
                            />
                        </div>

                        {/* 双手输入 */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            {/* 左手 */}
                            <div className="space-y-3">
                                <div className="flex items-center gap-2">
                                    <Hand className="h-4 w-4 text-muted-foreground" style={{ transform: 'scaleX(-1)' }} />
                                    <Label className="font-semibold">左手</Label>
                                </div>
                                {FINGERS_LEFT.map((finger) => (
                                    <div key={finger.code} className="flex items-center gap-3">
                                        <Label className="w-16 text-sm text-right">{finger.label}</Label>
                                        <Input
                                            type="number"
                                            step="0.5"
                                            min="5"
                                            max="25"
                                            value={formSizes[finger.code] || ''}
                                            onChange={(e) => handleSizeChange(finger.code, e.target.value)}
                                            placeholder="mm"
                                            className="w-24"
                                        />
                                        <span className="text-xs text-muted-foreground">mm</span>
                                    </div>
                                ))}
                            </div>

                            {/* 右手 */}
                            <div className="space-y-3">
                                <div className="flex items-center gap-2">
                                    <Hand className="h-4 w-4 text-muted-foreground" />
                                    <Label className="font-semibold">右手</Label>
                                </div>
                                {FINGERS_RIGHT.map((finger) => (
                                    <div key={finger.code} className="flex items-center gap-3">
                                        <Label className="w-16 text-sm text-right">{finger.label}</Label>
                                        <Input
                                            type="number"
                                            step="0.5"
                                            min="5"
                                            max="25"
                                            value={formSizes[finger.code] || ''}
                                            onChange={(e) => handleSizeChange(finger.code, e.target.value)}
                                            placeholder="mm"
                                            className="w-24"
                                        />
                                        <span className="text-xs text-muted-foreground">mm</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* 操作按钮 */}
                        <div className="flex gap-3">
                            <Button onClick={handleSave} disabled={isPending} className="gap-2">
                                <Save className="h-4 w-4" />
                                {isPending ? '保存中...' : '保存'}
                            </Button>
                            <Button variant="outline" onClick={handleCancel}>
                                <X className="h-4 w-4 mr-2" />
                                取消
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* 已有档案列表 */}
            {profiles.length === 0 && !isEditing ? (
                <Card className="text-center py-12">
                    <CardContent>
                        <p className="text-muted-foreground mb-4">还没有指甲尺寸档案</p>
                        <Button onClick={handleStartCreate} variant="outline" className="gap-2">
                            <Plus className="h-4 w-4" />
                            创建第一个档案
                        </Button>
                    </CardContent>
                </Card>
            ) : (
                <div className="space-y-4">
                    {profiles.map((profile) => (
                        <Card key={profile.id}>
                            <CardHeader className="pb-3">
                                <div className="flex items-center justify-between">
                                    <CardTitle className="text-base">{profile.profileName}</CardTitle>
                                    <div className="flex gap-2">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => handleStartEdit(profile)}
                                            disabled={isEditing}
                                        >
                                            <Edit2 className="h-4 w-4" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => handleDelete(profile.id)}
                                            disabled={isPending || isEditing}
                                            className="text-destructive hover:text-destructive"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent>
                                <div className="grid grid-cols-2 gap-4">
                                    {/* 左手数据 */}
                                    <div className="space-y-1">
                                        <p className="text-xs font-medium text-muted-foreground">左手</p>
                                        {FINGERS_LEFT.map((finger) => (
                                            <div key={finger.code} className="flex justify-between text-xs">
                                                <span>{finger.label}</span>
                                                <Badge variant="outline" className="text-[10px]">
                                                    {profile.fingerSizes[finger.code] || '-'} mm
                                                </Badge>
                                            </div>
                                        ))}
                                    </div>
                                    {/* 右手数据 */}
                                    <div className="space-y-1">
                                        <p className="text-xs font-medium text-muted-foreground">右手</p>
                                        {FINGERS_RIGHT.map((finger) => (
                                            <div key={finger.code} className="flex justify-between text-xs">
                                                <span>{finger.label}</span>
                                                <Badge variant="outline" className="text-[10px]">
                                                    {profile.fingerSizes[finger.code] || '-'} mm
                                                </Badge>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
        </div>
    );
}
