package com.baanporjai.ofresh.widget

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class DailyCalendar(
    val monthLabel: String,
    val daysInMonth: Int,
    val firstWeekday: Int,
    val cups: Map<Int, Int>,
    val monthCups: Int,
    val today: Int?,
    val todayCups: Int,
)

// เรียก /api/widget/daily-sales-calendar บน order-api-worker.js ของ OFresh — endpoint นี้ต้องแนบ
// header X-Widget-Token ให้ตรงกับ secret WIDGET_TOKEN บน Worker (ดู order-api-worker.js) คืนค่า null
// เมื่อเรียกไม่สำเร็จทุกกรณี (เน็ตหลุด/token ผิด/Worker ล่ม) ให้ WidgetRenderer ไปแสดงสถานะ "โหลดไม่สำเร็จ" แทน
object DailySalesApi {

    fun fetch(): DailyCalendar? {
        return try {
            val url = URL("${BuildConfig.WORKER_BASE_URL}/api/widget/daily-sales-calendar")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.setRequestProperty("X-Widget-Token", BuildConfig.WIDGET_TOKEN)
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000

            if (conn.responseCode != 200) {
                conn.disconnect()
                return null
            }

            val body = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            parse(body)
        } catch (e: Exception) {
            null
        }
    }

    private fun parse(body: String): DailyCalendar {
        val json = JSONObject(body)
        val cupsObj = json.getJSONObject("cups")
        val cups = mutableMapOf<Int, Int>()
        cupsObj.keys().forEach { key -> cups[key.toInt()] = cupsObj.getInt(key) }

        val todayStr = if (json.isNull("today")) null else json.optString("today", null)

        return DailyCalendar(
            monthLabel = json.getString("monthLabel"),
            daysInMonth = json.getInt("daysInMonth"),
            firstWeekday = json.getInt("firstWeekday"),
            cups = cups,
            monthCups = json.optInt("monthCups", 0),
            today = todayStr?.toIntOrNull(),
            todayCups = json.optInt("todayCups", 0),
        )
    }
}
