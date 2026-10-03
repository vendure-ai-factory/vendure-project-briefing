import type { Metadata } from 'next';
import { query } from '@/lib/vendure/api';

export const metadata: Metadata = {
    title: 'My Orders',
};
import { GetMyAllChannelOrdersQuery } from '@/lib/vendure/queries';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, } from '@/components/ui/table';
import {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
} from '@/components/ui/pagination';
import { ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Price } from '@/components/commerce/price';
import { OrderStatusBadge } from '@/components/commerce/order-status-badge';
import { formatDate } from '@/lib/format';
import Link from "next/link";
import { redirect } from "next/navigation";

const ITEMS_PER_PAGE = 10;

export default async function OrdersPage(props: PageProps<'/account/orders'>) {
    const searchParams = await props.searchParams;
    const pageParam = searchParams.page;
    const currentPage = parseInt(Array.isArray(pageParam) ? pageParam[0] : pageParam || '1', 10);
    const skip = (currentPage - 1) * ITEMS_PER_PAGE;

    let data;
    try {
        const res = await query(
            GetMyAllChannelOrdersQuery,
            {},
            { useAuthToken: true }
        );
        data = res.data;
    } catch (e: any) {
        console.error(`[OrdersPage] Failed to fetch orders: ${e}`);

        // Only redirect if it looks like an auth issue
        if (e?.message?.includes('unauthorized') || e?.status === 401 || e?.status === 403) {
            return redirect('/sign-in');
        }

        return (
            <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
                <h1 className="text-2xl font-bold text-red-500">无法加载订单数据集 (Error Loading Orders)</h1>
                <p className="text-gray-600 text-center max-w-md">
                    系统无法从后台获取订单信息。这通常是因为前端与后端的数据结构暂不同步导致的。
                    <br />请稍后再试或联系技术支持。
                </p>
                <div className="p-4 bg-gray-100 rounded text-xs text-red-600 max-w-full overflow-auto">
                    {e?.message || String(e) || 'Unknown error'}
                </div>
                <Button asChild variant="outline">
                    <Link href="/">返回首页</Link>
                </Button>
            </div>
        );
    }

    if (!data?.myAllChannelOrders) {
        console.warn('[OrdersPage] No myAllChannelOrders found in response, but no error thrown');
        return (
            <div className="flex flex-col items-center justify-center min-h-[400px] gap-2">
                <p className="text-gray-500">未找到订单频道数据 (No channel order data found)</p>
                <Button asChild variant="link">
                    <Link href="/sign-in">重新登录并重试</Link>
                </Button>
            </div>
        );
    }

    // Filter and sort manually since we are using the aggregator which returns all
    const allOrders = (data.myAllChannelOrders || []) as any[];
    const totalItems = allOrders.length;
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
    const orders = allOrders.slice(skip, skip + ITEMS_PER_PAGE);

    return (
        <div>
            <h1 className="text-3xl font-bold mb-6">My Orders</h1>

            {orders.length === 0 ? (
                <div className="text-center py-12">
                    <p className="text-gray-500">You haven&apos;t placed any orders yet.</p>
                </div>
            ) : (
                <>
                    <div className="border rounded-lg">
                        <Table>
                            <TableHeader className="bg-muted">
                                <TableRow>
                                    <TableHead>Order Number</TableHead>
                                    <TableHead>Date</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead>Items</TableHead>
                                    <TableHead className="text-right">Total</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {orders.map((order) => (
                                    <TableRow key={order.id} className="hover:bg-muted/50">
                                        <TableCell className="font-medium">
                                            <Button asChild variant="outline">
                                                <Link
                                                    href={`/account/orders/${order.code}`}
                                                >
                                                    {order.code} <ArrowRightIcon />
                                                </Link>
                                            </Button>
                                        </TableCell>
                                        <TableCell>
                                            {formatDate(order.createdAt)}
                                        </TableCell>
                                        <TableCell>
                                            <OrderStatusBadge state={order.state} />
                                        </TableCell>
                                        <TableCell>
                                            {order.lineCount}{' '}
                                            {order.lineCount === 1 ? 'item' : 'items'}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Price value={order.totalWithTax} currencyCode={order.currencyCode} />
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>

                    {totalPages > 1 && (
                        <div className="mt-6">
                            <Pagination>
                                <PaginationContent>
                                    <PaginationItem>
                                        <PaginationPrevious
                                            href={
                                                currentPage > 1
                                                    ? `/account/orders?page=${currentPage - 1}`
                                                    : '#'
                                            }
                                            className={
                                                currentPage === 1
                                                    ? 'pointer-events-none opacity-50'
                                                    : ''
                                            }
                                        />
                                    </PaginationItem>

                                    {Array.from({ length: totalPages }, (_, i) => i + 1).map(
                                        (page) => {
                                            if (
                                                page === 1 ||
                                                page === totalPages ||
                                                (page >= currentPage - 1 &&
                                                    page <= currentPage + 1)
                                            ) {
                                                return (
                                                    <PaginationItem key={page}>
                                                        <PaginationLink
                                                            href={`/account/orders?page=${page}`}
                                                            isActive={page === currentPage}
                                                        >
                                                            {page}
                                                        </PaginationLink>
                                                    </PaginationItem>
                                                );
                                            } else if (
                                                page === currentPage - 2 ||
                                                page === currentPage + 2
                                            ) {
                                                return (
                                                    <PaginationItem key={page}>
                                                        <PaginationEllipsis />
                                                    </PaginationItem>
                                                );
                                            }
                                            return null;
                                        }
                                    )}

                                    <PaginationItem>
                                        <PaginationNext
                                            href={
                                                currentPage < totalPages
                                                    ? `/account/orders?page=${currentPage + 1}`
                                                    : '#'
                                            }
                                            className={
                                                currentPage === totalPages
                                                    ? 'pointer-events-none opacity-50'
                                                    : ''
                                            }
                                        />
                                    </PaginationItem>
                                </PaginationContent>
                            </Pagination>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
