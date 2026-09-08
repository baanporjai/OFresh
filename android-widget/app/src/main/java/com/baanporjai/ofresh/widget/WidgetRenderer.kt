package com.baanporjai.ofresh.widget

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// สร้าง RemoteViews ของ widget_calendar.xml จากข้อมูลที่ดึงมาจาก DailySalesApi — แยกออกมาจาก
// CalendarWidgetProvider เพื่อให้ทดสอบ/อ่านแยกจาก lifecycle ของ AppWidgetProvider ได้ง่ายกว่า
object WidgetRenderer {

    private const val ROWS = 6
    private const val COLS = 7

    fun render(context: Context, data: DailyCalendar?): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_calendar)

        // แตะที่ widget ทั้งก้อน = ยิง broadcast รีเฟรชทันที ไม่ต้องรอรอบ updatePeriodMillis (30 นาที)
        val refreshIntent = Intent(context, CalendarWidgetProvider::class.java).apply {
            action = ACTION_REFRESH
        }
        val pendingIntent = PendingIntent.getBroadcast(
            context, 0, refreshIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        views.setOnClickPendingIntent(R.id.widget_root, pendingIntent)

        clearAllCells(context, views)

        if (data == null) {
            views.setTextViewText(R.id.month_label, context.getString(R.string.load_failed))
            views.setTextViewText(R.id.month_total, "")
            views.setTextViewText(R.id.updated_at, context.getString(R.string.tap_to_retry))
            return views
        }

        views.setTextViewText(R.id.month_label, data.monthLabel)
        views.setTextViewText(R.id.month_total, "${data.monthCups} แก้ว")

        val nowLabel = SimpleDateFormat("HH:mm", Locale("th", "TH")).format(Date())
        views.setTextViewText(R.id.updated_at, "อัปเดต $nowLabel น.")

        val maxDay = data.cups.values.maxOrNull()?.takeIf { it > 0 } ?: 0

        for (day in 1..data.daysInMonth) {
            val idx = data.firstWeekday + day - 1
            val row = idx / COLS
            val col = idx % COLS
            if (row >= ROWS) continue // เดือนไม่มีทางยาวเกิน 6 แถวในปฏิทินจริง แต่กันไว้เผื่อข้อมูลผิดปกติ

            val cellId = cellId(context, row, col)
            if (cellId == 0) continue

            val cups = data.cups[day] ?: 0
            val isToday = data.today == day

            // ไม่โชว์เลขวันที่ในช่อง เอาแค่จำนวนแก้ว — ตำแหน่งช่อง + แถวหัวตาราง อา-ส ก็พอบอกวันได้อยู่แล้ว
            // ช่องวันนี้แยกด้วยพื้นเข้ม (day_cell_today) จึงยังหาตำแหน่ง "วันนี้" เจอแม้ไม่มีเลขวันที่
            views.setTextViewText(cellId, if (cups > 0) cups.toString() else "")

            when {
                isToday -> {
                    views.setInt(cellId, "setBackgroundResource", R.drawable.day_cell_today)
                    views.setTextColor(cellId, 0xFFFFFFFF.toInt())
                }
                cups <= 0 -> {
                    views.setInt(cellId, "setBackgroundResource", R.drawable.day_cell_level0)
                    views.setTextColor(cellId, context.getColor(R.color.text_muted))
                }
                else -> {
                    val ratio = cups.toDouble() / maxDay
                    val level = when {
                        ratio >= 0.75 -> R.drawable.day_cell_level4
                        ratio >= 0.5 -> R.drawable.day_cell_level3
                        ratio >= 0.25 -> R.drawable.day_cell_level2
                        else -> R.drawable.day_cell_level1
                    }
                    views.setInt(cellId, "setBackgroundResource", level)
                    views.setTextColor(cellId, context.getColor(R.color.text_primary))
                }
            }
        }

        return views
    }

    private fun clearAllCells(context: Context, views: RemoteViews) {
        for (row in 0 until ROWS) {
            for (col in 0 until COLS) {
                val id = cellId(context, row, col)
                if (id == 0) continue
                views.setTextViewText(id, "")
                views.setInt(id, "setBackgroundResource", R.drawable.day_cell_level0)
                views.setTextColor(id, context.getColor(R.color.text_primary))
            }
        }
    }

    // ช่องปฏิทินมี id แบบ day_<row>_<col> คงที่ 42 ช่อง (ดู widget_calendar.xml) — ใช้ getIdentifier
    // แทนตารางแมป id 42 ตัวตรงๆ เพื่อให้โค้ดกระชับ (เรียกแค่ ~84 ครั้งต่อการรีเฟรชหนึ่งรอบ ไม่กระทบ
    // performance)
    private fun cellId(context: Context, row: Int, col: Int): Int =
        context.resources.getIdentifier("day_${row}_${col}", "id", context.packageName)
}
