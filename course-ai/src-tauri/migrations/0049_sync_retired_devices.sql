-- 网盘同步里被「移除」的设备：列表里不再显示。它的数据已经折进网盘上的底稿，新设备照样能拿到；
-- 它要是其实还在用，下次推送时会自己摘掉标记，这里也跟着恢复。
ALTER TABLE sync_remote_cursors ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
