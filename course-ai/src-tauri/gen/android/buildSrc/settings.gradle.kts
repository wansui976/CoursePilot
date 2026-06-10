pluginManagement {
    repositories {
        maven(url = "https://maven.aliyun.com/repository/public/")
        maven(url = "https://maven.aliyun.com/repository/google/")
        google()
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        maven(url = "https://maven.aliyun.com/repository/public/")
        maven(url = "https://maven.aliyun.com/repository/google/")
        google()
        mavenCentral()
    }
}
