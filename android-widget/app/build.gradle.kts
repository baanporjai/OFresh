import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// อ่านค่า WORKER_BASE_URL / WIDGET_TOKEN จากไฟล์ widget.secrets.properties (ไม่ track ใน git) แทนการ
// hardcode ในโค้ด — ไฟล์นี้อยู่ที่ root ของ android-widget/ ดู widget.secrets.properties.example
val secretsFile = rootProject.file("widget.secrets.properties")
val secrets = Properties().apply {
    if (secretsFile.exists()) secretsFile.inputStream().use { load(it) }
}
fun secret(key: String, fallback: String): String = secrets.getProperty(key, fallback)

android {
    namespace = "com.baanporjai.ofresh.widget"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.baanporjai.ofresh.widget"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        buildConfigField("String", "WORKER_BASE_URL", "\"${secret("WORKER_BASE_URL", "https://CHANGE_ME.workers.dev")}\"")
        buildConfigField("String", "WIDGET_TOKEN", "\"${secret("WIDGET_TOKEN", "")}\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
