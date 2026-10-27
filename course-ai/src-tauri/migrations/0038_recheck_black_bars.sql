-- 黑边探测的样本合并从「每边取最小值」改为「3 处及以上取中位数」。
-- 旧结果可能被片头动画/转场带偏：例如片头里画面临时铺到边缘，测出的下边是 0，
-- 取最小值就把正片一直存在的上下黑边否掉了。清空一次，让播放器/流水线按新算法重测。
UPDATE videos
SET crop_top = NULL, crop_right = NULL, crop_bottom = NULL, crop_left = NULL
WHERE crop_top IS NOT NULL;
