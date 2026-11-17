buildscript {
    repositories {
        // 阿里云镜像只给本机构建用（国内连 Google / Maven Central 慢）。CI 跑在海外，镜像排在前面
        // 反而多一个会断的环节：2026-11-16 发 v0.4.1 时它回 502，Gradle 把它禁掉后整个构建失败。
        if (System.getenv("CI") == null) {
            maven(url = "https://maven.aliyun.com/repository/public/")
            maven(url = "https://maven.aliyun.com/repository/google/")
        }
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

allprojects {
    repositories {
        // 阿里云镜像只给本机构建用（国内连 Google / Maven Central 慢）。CI 跑在海外，镜像排在前面
        // 反而多一个会断的环节：2026-11-16 发 v0.4.1 时它回 502，Gradle 把它禁掉后整个构建失败。
        if (System.getenv("CI") == null) {
            maven(url = "https://maven.aliyun.com/repository/public/")
            maven(url = "https://maven.aliyun.com/repository/google/")
        }
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}
