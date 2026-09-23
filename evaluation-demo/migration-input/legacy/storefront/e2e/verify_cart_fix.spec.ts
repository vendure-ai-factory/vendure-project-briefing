import { test, expect } from '@playwright/test';

test('should add item to cart in correct channel and show in cart page', async ({ page }) => {
  // Use a known Hungarian product
  // We saw this in the logs: testhu-sku-20260316-110847-0002
  await page.goto('/hu/product/testhu-sku-20260316-110847-0002');
  
  // Wait for the button to be visible and enabled
  const addToCartButton = page.getByRole('button', { name: /Add to Cart/i });
  await expect(addToCartButton).toBeVisible();
  
  // Click Add to Cart
  await addToCartButton.click();
  
  // Wait for success toast
  await expect(page.getByText(/Added to cart/i)).toBeVisible();
  
  // Navigate to Cart page
  await page.goto('/hu/cart');
  
  // Verify that the cart is NOT empty. 
  // An empty cart shows "购物车是空的" or "Empty Cart" and an OrderMergePrompt.
  // We expect to see the product name "testHU"
  await expect(page.getByText('testHU')).toBeVisible();
  
  // Also check that the "购物车是空的" text is NOT present
  await expect(page.getByText(/购物车是空的/i)).not.toBeVisible();
});
