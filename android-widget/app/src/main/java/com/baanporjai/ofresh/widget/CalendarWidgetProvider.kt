package com.baanporjai.ofresh.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

const val ACTION_REFRESH = "com.baanporjai.ofresh.widget.ACTION_REFRESH"

// อัปเดตทุก 30 นาทีตาม updatePeriodMillis ใน widget_info.xml (ค่าต่ำสุดที่ Android ยอมรับ) เพราะข้อมูล
// ยอดขาย Nayax อัปเดตแค่วันละครั้งอยู่แล้ว (เหมือน pattern เดียวกับ /realstat/* ในเว็บหลัก) — เพิ่มปุ่ม
// แตะ-รีเฟรชทันทีผ่าน ACTION_REFRESH ให้ไม่ต้องรอครบรอบเวลาเวลาอยากดูเลขสดๆ
class CalendarWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        appWidgetIds.forEach { id -> refreshWidget(context, appWidgetManager, id) }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, CalendarWidgetProvider::class.java))
            ids.forEach { id -> refreshWidget(context, manager, id) }
        }
    }

    private fun refreshWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int) {
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val data = DailySalesApi.fetch()
                val views = WidgetRenderer.render(context, data)
                appWidgetManager.updateAppWidget(appWidgetId, views)
            } finally {
                pending.finish()
            }
        }
    }
}
