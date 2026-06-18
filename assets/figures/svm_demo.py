"""
支持向量机（SVM）二分类可视化演示
使用线性核与 RBF 核分别对模拟数据进行分类，并绘制决策边界
"""

import numpy as np
import matplotlib.pyplot as plt
from sklearn import svm, datasets
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score

# ============ 1. 生成模拟数据（两类环形/异或分布，线性不可分） ============
np.random.seed(42)
X, y = datasets.make_circles(n_samples=300, noise=0.12, factor=0.4)

# 划分训练集和测试集
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.3, random_state=42
)

# ============ 2. 定义绘制决策边界的工具函数 ============
def make_meshgrid(x, y, h=.02):
    """创建用于绘制的网格点"""
    x_min, x_max = x.min() - 0.5, x.max() + 0.5
    y_min, y_max = y.min() - 0.5, y.max() + 0.5
    xx, yy = np.meshgrid(np.arange(x_min, x_max, h),
                         np.arange(y_min, y_max, h))
    return xx, yy

def plot_decision_boundary(ax, clf, xx, yy, **params):
    """绘制分类器的决策边界"""
    Z = clf.predict(np.c_[xx.ravel(), yy.ravel()])
    Z = Z.reshape(xx.shape)
    out = ax.contourf(xx, yy, Z, **params)
    return out

# ============ 3. 训练两个 SVM：线性核 vs RBF 核 ============
models = (
    svm.SVC(kernel='linear', C=1.0),
    svm.SVC(kernel='rbf', gamma=2.0, C=1.0),
)
models = (clf.fit(X_train, y_train) for clf in models)

titles = (
    'SVM with Linear Kernel',
    'SVM with RBF Kernel',
)

# ============ 4. 绘制对比图 ============
fig, sub = plt.subplots(1, 2, figsize=(12, 5))
plt.subplots_adjust(wspace=0.3, hspace=0.3)

X0, X1 = X[:, 0], X[:, 1]
xx, yy = make_meshgrid(X0, X1)

results = []
for clf, title, ax in zip(models, titles, sub.flatten()):
    # 计算测试集准确率
    y_pred = clf.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    results.append((title, acc))

    # 绘制决策边界
    plot_decision_boundary(ax, clf, xx, yy, cmap=plt.cm.coolwarm, alpha=0.7)
    # 绘制样本点
    ax.scatter(X0, X1, c=y, cmap=plt.cm.coolwarm, s=50, edgecolors='k')
    # 标记支持向量
    sv = clf.support_vectors_
    ax.scatter(sv[:, 0], sv[:, 1], s=150, linewidth=1.5,
               facecolors='none', edgecolors='yellow', label='Support Vectors')

    ax.set_xlim(xx.min(), xx.max())
    ax.set_ylim(yy.min(), yy.max())
    ax.set_xlabel('Feature 1')
    ax.set_ylabel('Feature 2')
    ax.set_xticks(())
    ax.set_yticks(())
    ax.set_title(f'{title}\nAccuracy: {acc:.3f}')
    ax.legend(loc='upper right')

plt.suptitle('Support Vector Machine: Linear vs RBF Kernel on Circle Data',
             fontsize=14, fontweight='bold')
plt.tight_layout()

# 保存图片
output_path = 'testrange/svm_decision_boundary.png'
plt.savefig(output_path, dpi=150, bbox_inches='tight')
print(f"图片已保存到: {output_path}")
print("\n准确率结果:")
for title, acc in results:
    print(f"  {title}: {acc:.4f}")
