-- 黑边探测的样本合并从「每边取最小值」改为「3 处及以上取中位数」。
-- 旧结果可能被片头动画/转场带偏：例如片头里画面临时铺到边缘，测出的下边是 0，
-- 取最小值就把正片一直存在的上下黑边否掉了。
--
-- 只清空「四边不对称」的缓存（真正受影响的那些）；对称且合理的结果保留，
-- 避免每次升级都把所有视频重新解码一遍。清空后播放器/流水线会按新算法重测。
UPDATE videos
SET crop_top = NULL, crop_right = NULL, crop_bottom = NULL, crop_left = NULL
WHERE crop_top IS NOT NULL
  AND (ABS(crop_top - crop_bottom) > 0.001 OR ABS(crop_left - crop_right) > 0.001);
